import sys, os, types, json, shutil
import numpy as np

_browser_mmap = types.ModuleType("mmap")
_browser_mmap.ACCESS_READ = 1
_browser_mmap.ACCESS_WRITE = 2
_browser_mmap.ACCESS_COPY = 3
_browser_mmap.PAGESIZE = 65536
_browser_mmap.ALLOCATIONGRANULARITY = 65536
class _BrowserMMap(bytearray):
    def __new__(cls, fileno, length=0, tagname=None, access=None, offset=0): return super().__new__(cls)
    def __init__(self, fileno, length=0, tagname=None, access=None, offset=0): super().__init__(); self._closed=False; self._pos=0
    def close(self): self._closed=True
    @property
    def closed(self): return self._closed
    def flush(self): return 0
    def seek(self, pos, whence=0):
        if whence==0: self._pos=max(0,int(pos))
        elif whence==1: self._pos=max(0,self._pos+int(pos))
        else: self._pos=0
        return self._pos
    def tell(self): return self._pos
    def read(self,n=-1): return b""
    def size(self): return 0
    def __enter__(self): return self
    def __exit__(self,*exc): self.close()
_browser_mmap.mmap=_BrowserMMap
_browser_mmap.error=OSError
sys.modules["mmap"]=_browser_mmap

import nd2
from nd2._readers._modern.modern_reader import ModernReader
# The engine imports nd2 while it warms up, before the stand-in above is in sys.modules,
# so nd2's reader would still map the whole file into memory when opening it. A large
# ND2 is mounted rather than copied into the engine (a 6 GB file cannot be copied), and a
# mounted file cannot be mapped, so the reader is pointed at the stand-in too; frames are
# read by seeking (below) either way.
import nd2._readers.protocol as _nd2_protocol
_nd2_protocol.mmap=_browser_mmap

def _stream_read_frame(self,index:int):
    if not self._fh: raise ValueError("Attempt to read from closed nd2 file")
    offset=self._frame_offsets.get(index,None)
    if offset is None:
        if index>self._seq_count(): raise IndexError(f"Frame out of range: {index}")
        return self._missing_frame(index)
    if self.attributes().compressionType=="lossless": return self._read_compressed_frame(index)
    shape=self._actual_frame_shape(); dtype=self._dtype(); strides=self._strides; attrs=self.attributes()
    row_bytes=int(attrs.widthBytes or 0)
    if row_bytes<=0: row_bytes=int((attrs.widthPx or 1)*attrs.componentCount*dtype.itemsize)
    nbytes=int(row_bytes*attrs.heightPx)
    try: old_pos=self._fh.tell()
    except Exception: old_pos=None
    try:
        self._fh.seek(int(offset)); data=self._fh.read(nbytes)
    finally:
        if old_pos is not None:
            try: self._fh.seek(old_pos)
            except Exception: pass
    if len(data)<nbytes: return self._missing_frame(index)
    try: return np.ndarray(shape=shape,dtype=dtype,buffer=data,strides=strides).copy()
    except (TypeError,ValueError): return self._missing_frame(index)
ModernReader.read_frame=_stream_read_frame


# ── Zeiss CZI ───────────────────────────────────────────────────────────────
# A CZI is read here with the same few calls the ND2 path makes on an
# nd2.ND2File (sizes, attributes, metadata.channels, voxel_size, read_frame),
# so everything built for ND2 -- channels, merges, Z max projection, scenes as
# positions, Image Prep and full resolution -- works on it unchanged.
# The format (ZISRAW): 32-byte segment headers; the file header names the
# subblock directory and the XML metadata; each subblock is one tile of one
# channel / Z / time / scene, at a pixel position, stored raw or Zstd-compressed
# (ZEN 3.x). Tiles of a mosaic are placed at their positions; only full-
# resolution tiles are read (pyramid levels are skipped).
import struct as _czi_struct
import xml.etree.ElementTree as _czi_xml
import re as _czi_re

_CZI_DTYPES={0:('uint8',1),1:('uint16',1),2:('float32',1),3:('uint8',3),4:('uint16',3),9:('uint8',4),12:('uint32',1)}
_CZI_COMPRESSION={0:'none',1:'JPEG',2:'LZW',4:'JPEG XR',5:'Zstd',6:'Zstd'}

class _CziObj:
    def __init__(self,**kw): self.__dict__.update(kw)

class CziFile:
    is_legacy=False
    def __init__(self,path):
        self.path=path; self._fh=open(path,'rb')
        sid,_,_=self._segment(0)
        if sid!='ZISRAWFILE': raise RuntimeError('Not a Zeiss CZI file.')
        self._fh.seek(32); head=self._fh.read(80)
        dir_pos,meta_pos=_czi_struct.unpack_from('<qq',head,52)
        self._entries=self._directory(dir_pos) if dir_pos>0 else self._scan()
        self._xml=self._metadata(meta_pos) if meta_pos>0 else None
        full=[e for e in self._entries if e['pyramid']==0 and all(e['dims'][d][1]==e['dims'][d][2] for d in ('X','Y') if d in e['dims'])]
        if not full: raise RuntimeError('This CZI has no full-resolution image data.')
        self._tiles=full
        pt=full[0]['pixel_type']
        if pt not in _CZI_DTYPES: raise RuntimeError(f'CZI pixel type {pt} is not supported.')
        self._np_dtype,self._components=_CZI_DTYPES[pt]
        def extent(d):
            vals=[e['dims'][d][0] for e in full if d in e['dims']]
            return (min(vals),max(vals)) if vals else (0,0)
        self._c0,c1=extent('C'); self._z0,z1=extent('Z'); self._t0,t1=extent('T')
        scenes=sorted({e['dims']['S'][0] for e in full if 'S' in e['dims']}) or [0]
        self._scenes=scenes
        # Each scene's own frame: its tiles' bounding box. Scenes of different sizes are
        # padded to the largest, as every position of one file shares one size here.
        self._frames={}
        for s in scenes:
            ts=[e for e in full if e['dims'].get('S',(0,))[0]==s] if 'S' in full[0]['dims'] else full
            x0=min(e['dims']['X'][0] for e in ts); y0=min(e['dims']['Y'][0] for e in ts)
            x1=max(e['dims']['X'][0]+e['dims']['X'][1] for e in ts); y1=max(e['dims']['Y'][0]+e['dims']['Y'][1] for e in ts)
            self._frames[s]=(x0,y0,x1-x0,y1-y0)
        w=max(f[2] for f in self._frames.values()); h=max(f[3] for f in self._frames.values())
        sizes={}
        if t1>self._t0: sizes['T']=t1-self._t0+1
        if len(scenes)>1: sizes['P']=len(scenes)
        if z1>self._z0: sizes['Z']=z1-self._z0+1
        sizes['C']=c1-self._c0+1 if self._components==1 else 1
        sizes['Y']=h; sizes['X']=w
        self.sizes=sizes
        self.is_rgb=self._components>1
        self.dtype=np.dtype(self._np_dtype)
        comp={e['compression'] for e in full}
        bits=self._xml_int('.//Information/Image/ComponentBitCount') or self.dtype.itemsize*8
        self.attributes=_CziObj(channelCount=sizes['C'],bitsPerComponentSignificant=bits,bitsPerComponentInMemory=self.dtype.itemsize*8,
                                compressionType='lossless' if comp-{0} else None)
        self.metadata=_CziObj(channels=self._channel_meta(sizes['C']))
        self._index={}
        for e in full:
            d=e['dims']
            key=(d['T'][0] if 'T' in d else 0,d['S'][0] if 'S' in d else 0,d['Z'][0] if 'Z' in d else 0,d['C'][0] if 'C' in d else 0)
            self._index.setdefault(key,[]).append(e)
    def __enter__(self): return self
    def __exit__(self,*exc): self.close()
    def close(self):
        try: self._fh.close()
        except Exception: pass
    # ── segments ──
    def _segment(self,pos):
        self._fh.seek(pos); h=self._fh.read(32)
        if len(h)<32: return '',0,0
        sid=h[:16].split(b'\0',1)[0].decode('ascii','replace'); alloc,used=_czi_struct.unpack_from('<qq',h,16)
        return sid,alloc,used
    def _entry(self,buf,off):
        pixel_type,file_pos,file_part,compression=_czi_struct.unpack_from('<iqii',buf,off+2)
        pyramid=buf[off+22]; count=_czi_struct.unpack_from('<i',buf,off+28)[0]; dims={}
        for k in range(count):
            o=off+32+20*k
            name=buf[o:o+4].split(b'\0',1)[0].decode('ascii','replace')
            start,size=_czi_struct.unpack_from('<ii',buf,o+4); stored=_czi_struct.unpack_from('<i',buf,o+16)[0]
            dims[name]=(start,size,stored)
        return {'pixel_type':pixel_type,'file_pos':file_pos,'compression':compression,'pyramid':pyramid,'dims':dims},32+20*count
    def _directory(self,pos):
        sid,_,_=self._segment(pos)
        if sid!='ZISRAWDIRECTORY': return self._scan()
        n=_czi_struct.unpack('<i',self._fh.read(4))[0]; self._fh.read(124)
        out=[]; buf=self._fh.read(n*(32+20*16)); off=0
        for _ in range(n):
            if off+32>len(buf): break
            e,size=self._entry(buf,off); off+=size; out.append(e)
        return out
    def _scan(self):
        out=[]; pos=0; size=os.path.getsize(self.path)
        while pos+32<=size:
            sid,alloc,_=self._segment(pos)
            if not sid: break
            if sid=='ZISRAWSUBBLOCK':
                buf=self._fh.read(16+32+20*16); e,_=self._entry(buf,16); e['file_pos']=pos; out.append(e)
            pos+=32+max(0,alloc)
        return out
    def _metadata(self,pos):
        sid,_,_=self._segment(pos)
        if sid!='ZISRAWMETADATA': return None
        xml_size=_czi_struct.unpack('<i',self._fh.read(4))[0]; self._fh.read(252)
        try: return _czi_xml.fromstring(self._fh.read(xml_size).decode('utf-8','replace'))
        except Exception: return None
    def _xml_int(self,path):
        try: return int(float(self._xml.find(path).text))
        except Exception: return 0
    def _channel_meta(self,count):
        info=self._xml.findall('.//Information/Image/Dimensions/Channels/Channel') if self._xml is not None else []
        disp=self._xml.findall('.//DisplaySetting/Channels/Channel') if self._xml is not None else []
        out=[]
        for i in range(count):
            ch=info[i] if i<len(info) else None; ds=disp[i] if i<len(disp) else None
            name=(ch.get('Name') if ch is not None else None) or (ds.get('Name') if ds is not None else None) or (ch.findtext('Fluor') if ch is not None else None) or f'Channel {i+1}'
            def num(el,tag):
                try: return float(el.findtext(tag))
                except Exception: return None
            em=num(ch,'EmissionWavelength') if ch is not None else None; ex=num(ch,'ExcitationWavelength') if ch is not None else None
            color=None; text=(ds.findtext('Color') if ds is not None else None) or (ch.findtext('Color') if ch is not None else None)
            if text and text.startswith('#') and len(text) in (7,9):
                h=text[-6:]; color=_CziObj(r=int(h[0:2],16),g=int(h[2:4],16),b=int(h[4:6],16))
            out.append(_CziObj(channel=_CziObj(name=name,emissionLambdaNm=em,excitationLambdaNm=ex,color=color)))
        return out
    def voxel_size(self):
        def um(axis):
            if self._xml is None: return 0.0
            for d in self._xml.findall('.//Scaling/Items/Distance'):
                if d.get('Id')==axis:
                    try: return float(d.findtext('Value'))*1e6
                    except Exception: return 0.0
            return 0.0
        return _CziObj(x=um('X'),y=um('Y'),z=um('Z'))
    # ── acquisition settings, for the image's "i" ──
    def acquisition(self):
        x=self._xml
        if x is None: return None
        info=x.find('.//Metadata/Information')
        if info is None: info=x.find('.//Information')
        if info is None: return None
        rows=[]
        def add(k,v):
            if v not in (None,''): rows.append([k,str(v)])
        def t(el,path):
            if el is None: return None
            v=el.findtext(path); return v.strip() if v and v.strip() else None
        when=t(info,'Image/AcquisitionDateAndTime') or t(info,'Document/CreationDate')
        m=_czi_re.match(r'(\d{4}-\d\d-\d\d)T(\d\d:\d\d:\d\d)[.\d]*(Z)?',when or '')
        add('Acquired',(m.group(1)+' '+m.group(2)+(' UTC' if m.group(3) else '')) if m else when)
        add('Software',' '.join(v for v in (t(info,'Application/Name'),t(info,'Application/Version')) if v))
        mic=info.find('Instrument/Microscopes/Microscope')
        if mic is not None: add('Microscope',' · '.join(v for v in (mic.get('Name'),t(mic,'Type')) if v))
        obj=info.find('Instrument/Objectives/Objective')
        if obj is not None:
            na=t(obj,'LensNA'); add('Objective',' · '.join(v for v in (obj.get('Name') or (t(obj,'NominalMagnification') and t(obj,'NominalMagnification')+'×'),na and 'NA '+na,t(obj,'Immersion')) if v))
        det=info.find('Instrument/Detectors/Detector')
        if det is not None:
            model=t(det,'Manufacturer/Model'); add('Detector',' · '.join(v for v in (det.get('Name'),model if model!=det.get('Name') else None) if v))
        nz=t(info,'Image/SizeZ'); step=t(info,'Image/Dimensions/Z/Positions/Interval/Increment')
        if nz and int(float(nz))>1: add('Z stack',f'{nz} planes'+(f' × {step} µm' if step else ''))
        for i,ch in enumerate(info.findall('Image/Dimensions/Channels/Channel')):
            name=ch.get('Name') or t(ch,'Fluor') or f'Channel {i+1}'; bits=[]
            ex=t(ch,'ExcitationWavelength'); em=t(ch,'EmissionWavelength')
            if ex or em: bits.append(' / '.join(v for v in (ex and 'ex '+ex,em and 'em '+em) if v)+' nm')
            exp=t(ch,'ExposureTime')
            if exp:
                try: bits.append(f'{float(exp)/1e6:g} ms exposure')
                except ValueError: bits.append('exposure '+exp)
            for ls in ch.findall('LightSourcesSettings/LightSourceSettings'):
                wl=t(ls,'Wavelength'); it=t(ls,'Intensity'); at=t(ls,'Attenuation')
                part=' '.join(v for v in (wl and f'{float(wl):g} nm',it,at and not it and f'{(1-float(at))*100:.1f}% transmission') if v)
                if part: bits.append('light '+part)
            for k,label in (('DetectorSettings/Gain','gain'),('DetectorSettings/Binning','binning'),('PinholeSizeAiry','pinhole AU'),('Reflector','reflector'),('AcquisitionMode','mode')):
                v=t(ch,k)
                if v: bits.append(f'{label} {v}')
            if bits: add(name,' · '.join(bits))
        lines=[]
        def walk(el,path,depth):
            if depth>9 or len(lines)>=1200: return
            for c in el:
                tag=c.tag.split('}')[-1]; nm=c.get('Name') or c.get('Id')
                q=(path+' / ' if path else '')+tag+(f' [{nm}]' if nm else '')
                v=(c.text or '').strip()
                if v and len(c)==0: lines.append(f'{q}: {v[:300]}')
                walk(c,q,depth+1)
        walk(info,'',0)
        return {'rows':rows,'text':'\n'.join(lines)[:20000]}
    # ── pixels ──
    def _tile(self,e):
        sid,_,_=self._segment(e['file_pos'])
        if sid!='ZISRAWSUBBLOCK': raise RuntimeError('CZI subblock is missing.')
        head=self._fh.read(16+32+20*16)
        meta_size,att_size,data_size=_czi_struct.unpack_from('<iiq',head,0)
        _,entry_size=self._entry(head,16)
        self._fh.seek(e['file_pos']+32+max(256,16+entry_size)+meta_size); data=self._fh.read(data_size)
        comp=e['compression']
        if comp in (5,6):
            try: import zstandard
            except ImportError: raise RuntimeError('Zstd-compressed CZI needs the zstandard package.')
            hilo=False
            if comp==6:
                hs=data[0]
                if hs>=3 and data[1]==1: hilo=bool(data[2]&1)
                data=data[hs:]
            data=zstandard.ZstdDecompressor().decompress(data,max_output_size=1<<31)
            if hilo:
                half=len(data)//2; b=np.frombuffer(data,np.uint8)
                data=np.stack([b[:half],b[half:]],axis=-1).tobytes()
        elif comp==4:
            # JPEG XR (Axioscan and other slide scans): decoded by jxrlib, built for the
            # browser, which the engine loads before a CZI is read (cziPrepare).
            try:
                from js import cziJxrDecode
                from pyodide.ffi import to_js
            except ImportError:
                raise RuntimeError('JPEG XR-compressed CZI needs the browser decoder.')
            data=bytes(cziJxrDecode(to_js(data)).to_py())
        elif comp!=0:
            raise RuntimeError(f'CZI tiles compressed as {_CZI_COMPRESSION.get(comp,comp)} are not supported; save the CZI from ZEN uncompressed, or with Zstd or JPEG XR compression.')
        w=e['dims']['X'][2]; h=e['dims']['Y'][2]
        a=np.frombuffer(data,dtype=self._np_dtype,count=w*h*self._components)
        return a.reshape((h,w,self._components)) if self._components>1 else a.reshape((h,w))
    def _coords(self,seq_index):
        axes=[a for a in self.sizes if a not in ('C','Y','X','S')]; out={}; rest=int(seq_index)
        for a in reversed(axes):
            out[a]=rest%self.sizes[a]; rest//=self.sizes[a]
        return out
    def read_frame(self,seq_index):
        c=self._coords(seq_index); t=self._t0+c.get('T',0); s=self._scenes[c.get('P',0)]; z=self._z0+c.get('Z',0)
        x0,y0,_,_=self._frames[s]; H=self.sizes['Y']; W=self.sizes['X']; n=self.sizes['C']
        out=np.zeros((n,H,W,self._components) if self._components>1 else (n,H,W),dtype=self._np_dtype)
        for ci in range(n):
            for e in self._index.get((t,s,z,self._c0+ci),[]):
                a=self._tile(e); tx=e['dims']['X'][0]-x0; ty=e['dims']['Y'][0]-y0
                hh=min(a.shape[0],H-ty); ww=min(a.shape[1],W-tx)
                if hh>0 and ww>0: out[ci,ty:ty+hh,tx:tx+ww]=a[:hh,:ww]
        return out

def _open_microscopy(path):
    return CziFile(path) if str(path).lower().endswith('.czi') else nd2.ND2File(path)

_SCALE_DOMAIN={}
# ── acquisition settings, for the image's "i" ─────────────────────────────────
# What the microscope recorded: date, objective, lasers and detectors, exposure,
# pinhole, Z/time loops, as short rows, plus everything NIS-Elements wrote as text.
import re as _acq_re
def _acq_text(v): return str(v or '').replace('\r\n','\n').replace('\r','\n').strip()
def _acq_num(v):
    try: return '%g'%float(v)
    except Exception: return str(v)
_ACQ_MODALITY={'fluorescence':'Fluorescence','brightfield':'Brightfield','laserScanConfocal':'Laser-scanning confocal','spinningDiskConfocal':'Spinning-disk confocal','sweptFieldConfocalSlit':'Swept-field confocal','sweptFieldConfocalPinhole':'Swept-field confocal','multiphoton':'Multiphoton','widefield':'Widefield','pmt':'PMT detector','camera':'Camera','tirf':'TIRF','phaseContrast':'Phase contrast','diContrast':'DIC'}
_ACQ_CH_WORDS={'Laser Wavelength':lambda v:f'{_acq_num(v)} nm laser','Laser Power':lambda v:f'{_acq_num(v)}% power','PMT HV':lambda v:f'HV {v}','PMT Offset':lambda v:f'offset {v}','PMT Gain':lambda v:f'gain {v}'}
# Repeats of a row above, or switches that are rarely changed (still in the full text).
_ACQ_QUIET={'Pinhole Size(um)','Scanner Zoom','HV LinearCorrection','Line Skip','Frame Skip','Channel Series Pass','Optical Path Mode','Scanner Selection','Detector Selection'}
def _nd2_acquisition(f):
    rows=[]
    def add(k,v):
        if v not in (None,''): rows.append([k,str(v)])
    try: ti=dict(f.text_info or {})
    except Exception: ti={}
    desc=_acq_text(ti.get('description')); cap=_acq_text(ti.get('capturing'))
    add('Acquired',_acq_text(ti.get('date')))
    m=_acq_re.search(r'^Camera Name:\s*(.+)$',desc,_acq_re.M)
    add('Camera',m.group(1).strip() if m else (cap.split('\n',1)[0].strip() or None if cap else None))
    m=_acq_re.search(r'Microscope:\s*([^\n]+)',desc); add('Microscope',m.group(1).strip() if m else None)
    mic=None
    try: mic=f.metadata.channels[0].microscope
    except Exception: pass
    if mic is not None:
        bits=[getattr(mic,'objectiveName',None) or _acq_text(ti.get('optics'))]
        na=getattr(mic,'objectiveNumericalAperture',None); ri=getattr(mic,'immersionRefractiveIndex',None)
        if na: bits.append('NA '+_acq_num(na))
        if ri: bits.append('n '+_acq_num(ri))
        add('Objective',' · '.join(b for b in bits if b))
        add('Modality',', '.join(_ACQ_MODALITY.get(x,x) for x in (getattr(mic,'modalityFlags',None) or [])))
        zm=getattr(mic,'zoomMagnification',None); ph=getattr(mic,'pinholeDiameterUm',None)
        if zm: add('Zoom',_acq_num(zm)+'×')
        if ph: add('Pinhole',_acq_num(ph)+' µm')
    else: add('Objective',_acq_text(ti.get('optics')))
    try:
        for lp in f.experiment or []:
            p=getattr(lp,'parameters',None)
            if lp.type=='ZStackLoop':
                step=getattr(p,'stepUm',None); add('Z stack',f'{lp.count} planes'+(f' × {_acq_num(step)} µm' if step else ''))
            elif lp.type=='TimeLoop':
                per=getattr(p,'periodMs',None); add('Time loop',f'{lp.count} frames'+(f' every {_acq_num(per/1000)} s' if per else ''))
            elif lp.type=='NETimeLoop': add('Time loop',f'{lp.count} frames')
            elif lp.type=='XYPosLoop': add('XY positions',str(lp.count))
    except Exception: pass
    # Scanner / camera settings: "{Key}: value" pairs; CHn lines (and their tab-indented
    # continuations) are one detector each.
    ch=None; per={}; avg_off=bool(_acq_re.search(r'\{Line Average Mode\}:\s*None',cap))
    for line in cap.split('\n'):
        if not line.strip(): continue
        lead=line.split('\t',1)[0].strip()
        if _acq_re.match(r'^(CH\d+|Stim\d+)$',lead): ch=lead
        elif not line.startswith('\t'): ch=None
        pairs=_acq_re.findall(r'\{([^}]+)\}:\s*([^\t]*)',line)
        if not pairs:
            m=_acq_re.match(r'^\s*([A-Za-z][^:{}\t]{0,40}):\s*(\S.*)$',line)
            pairs=[(m.group(1),m.group(2))] if m else []
        for k,v in pairs:
            k=k.strip(); v=v.strip()
            if not v or (ch or '').startswith('Stim'): continue
            if ch: per.setdefault(ch,[]).append(_ACQ_CH_WORDS[k](v) if k in _ACQ_CH_WORDS else f'{k} {v}')
            elif k not in _ACQ_QUIET and not (k.startswith('Line Average') and avg_off): add(k,v)
    planes=_acq_re.findall(r'Plane #\d+:\s*\n\s*Name:\s*([^\n]+)',desc)
    for i,(k,v) in enumerate(per.items()):
        add(f'{k} · {planes[i].strip()}' if len(planes)==len(per) else k,' · '.join(v))
    # Widefield: each plane's own exposure.
    for block in _acq_re.split(r'\n\s*Plane #\d+:',desc)[1:]:
        nm=_acq_re.search(r'^\s*Name:\s*(.+)$',block,_acq_re.M); ex=_acq_re.search(r'^\s*Exposure:\s*(.+)$',block,_acq_re.M)
        if nm and ex: add(nm.group(1).strip()+' exposure',ex.group(1).strip())
    text=desc
    for k,v in ti.items():
        v=_acq_text(v)
        if k not in ('description','capturing') and v and v not in text: text+=f'\n\n{k}:\n{v}'
    if not desc and cap: text=cap+'\n\n'+text
    text=text.strip()[:20000]
    return {'rows':rows,'text':text} if rows or text else None

def _acquisition(f):
    try: return f.acquisition() if hasattr(f,'acquisition') else _nd2_acquisition(f)
    except Exception: return None

def _notify(phase,done=0,total=1,detail=""):
    try:
        from js import figureNd2Progress
        figureNd2Progress(str(phase),int(done),int(total),str(detail))
    except Exception: pass

def _infer_rgb(name,emission=None):
    s=str(name or '').lower().replace('-','').replace('_','').replace(' ','')
    if any(k in s for k in ('dapi','hoechst','405','bfp')): return [70,110,255]
    if any(k in s for k in ('cfp','alexa430','alexa440','cyan')): return [0,220,255]
    if any(k in s for k in ('fitc','gfp','488','alexa488','zsgreen','green')): return [0,255,80]
    if any(k in s for k in ('yfp','venus','yellow')): return [255,235,0]
    if any(k in s for k in ('cy3','tritc','555','561','568','alexa555','alexa568','orange')): return [255,128,0]
    if any(k in s for k in ('tdtomato','texasred','mcherry','594','alexa594','red')): return [255,40,55]
    if any(k in s for k in ('cy5','647','640','alexa647','farred')): return [255,0,220]
    try:
        e=float(emission)
        if e<480:return [70,110,255]
        if e<510:return [0,210,255]
        if e<555:return [0,255,80]
        if e<590:return [255,220,0]
        if e<640:return [255,80,0]
        return [255,0,220]
    except Exception:return [255,255,255]

def _channel_details(f,count):
    out=[]
    try: channels=f.metadata.channels or []
    except Exception: channels=[]
    for i in range(count):
        name=f'Channel {i+1}'; emission=None; excitation=None; rgb=None; source='inferred'
        if i<len(channels):
            try:
                cm=getattr(channels[i],'channel',None); n=getattr(cm,'name',None)
                if n:name=str(n)
                emission=getattr(cm,'emissionLambdaNm',None); excitation=getattr(cm,'excitationLambdaNm',None); col=getattr(cm,'color',None)
                if col is not None:
                    rgb=[int(max(0,min(255,getattr(col,k)))) for k in ('r','g','b')]
                    if max(rgb)>8:source='metadata'
                    else:rgb=None
            except Exception:pass
        if rgb is None:rgb=_infer_rgb(name,emission)
        out.append({'name':name,'rgb':rgb,'colorSource':source,'emissionNm':None if emission is None else float(emission),'excitationNm':None if excitation is None else float(excitation)})
    return out

def _info_dict(f,name=''):
    sizes={str(k):int(v) for k,v in f.sizes.items()}; attrs=f.attributes; count=int(sizes.get('C',attrs.channelCount or 1)); pos_axis='P' if 'P' in sizes else ('V' if 'V' in sizes else None); details=_channel_details(f,count)
    pixel_um=None; z_um=None
    try:
        vox=f.voxel_size(); px=float(getattr(vox,'x',0) or 0); pz=float(getattr(vox,'z',0) or 0)
        pixel_um=px if px>0 else None; z_um=pz if pz>0 else None
    except Exception:pass
    return {'filename':name,'sizes':sizes,'dtype':str(f.dtype),'bitsSignificant':int(getattr(attrs,'bitsPerComponentSignificant',0) or getattr(attrs,'bitsPerComponentInMemory',0) or 0),'bitsInMemory':int(getattr(attrs,'bitsPerComponentInMemory',0) or 0),'channelCount':count,'channels':[x['name'] for x in details],'channelMeta':details,'legacy':bool(f.is_legacy),'isRgb':bool(f.is_rgb),'counts':{'time':int(sizes.get('T',1)),'position':int(sizes.get(pos_axis,1)) if pos_axis else 1},'positionAxis':pos_axis,'width':int(sizes.get('X',0)),'height':int(sizes.get('Y',0)),'zCount':int(sizes.get('Z',1)),'pixelSizeUm':pixel_um,'zStepUm':z_um,'acquisition':_acquisition(f)}

def figure_nd2_info(path,name=''):
    _notify('metadata',0,1,name)
    with _open_microscopy(path) as f: info=_info_dict(f,name)
    _notify('metadata',1,1,name)
    return json.dumps(info)

# ── Multipoint files: where each point is, and a small picture of it ──────────
# The points window draws every M position at its stage position, each with a
# picture of its middle Z plane, so a slide of several brains can be seen whole and
# its points grouped, opened or split. The file is kept open between pictures.
_POINTS_OPEN={'path':None,'f':None}
def _points_file(path):
    if _POINTS_OPEN['path']!=path:
        figure_nd2_points_close()
        _POINTS_OPEN['f']=_open_microscopy(path); _POINTS_OPEN['path']=path
    return _POINTS_OPEN['f']
def figure_nd2_points_close():
    f=_POINTS_OPEN.get('f')
    if f is not None:
        try:f.close()
        except Exception:pass
    _POINTS_OPEN['f']=None; _POINTS_OPEN['path']=None
    return True
def figure_nd2_points(path,name=''):
    f=_points_file(path); sizes={str(k):int(v) for k,v in f.sizes.items()}
    pos_axis='P' if 'P' in sizes else ('V' if 'V' in sizes else None); count=int(sizes.get(pos_axis,1)) if pos_axis else 1
    names=[None]*count; stage=[None]*count
    try:
        for lp in (getattr(f,'experiment',None) or []):
            if lp.type=='XYPosLoop':
                for i,pt in enumerate(list(lp.parameters.points)[:count]):
                    names[i]=str(getattr(pt,'name','') or '').strip() or None
                    xyz=getattr(pt,'stagePositionUm',None)
                    if xyz is not None and len(xyz)>=2:stage[i]=[float(xyz[0]),float(xyz[1]),float(xyz[2]) if len(xyz)>2 else None]
    except Exception:pass
    um=None
    try:
        vox=f.voxel_size(); um=float(getattr(vox,'x',0) or 0) or None
    except Exception:pass
    X=int(sizes.get('X',0)); Y=int(sizes.get('Y',0))
    return json.dumps({'filename':name,'count':count,'axis':pos_axis,'names':[n or 'M%d'%(i+1) for i,n in enumerate(names)],'stage':stage,
        'width':X,'height':Y,'pixelUm':um,'fieldUm':[X*um,Y*um] if um else None,'z':int(sizes.get('Z',1)),'channels':int(sizes.get('C',1)),
        'bytesPerPoint':int(X*Y*int(sizes.get('C',1))*int(sizes.get('Z',1))*int(sizes.get('T',1))*np.dtype(f.dtype).itemsize)})
def _thin_planes(f,seq_index,count,step):
    """Every step-th row and column of one frame, a 2D plane per channel. Where the
    ND2 stores its frames uncompressed only those rows are read (a picture of a
    44 MB frame reads about 4 MB); otherwise the frame is read whole and thinned."""
    step=max(1,int(step)); rdr=getattr(f,'_rdr',None)
    try:
        off=rdr._frame_offsets.get(int(seq_index)) if step>1 else None
        attrs=rdr.attributes()
        if off is None or attrs.compressionType=='lossless':raise LookupError
        dtype=np.dtype(rdr._dtype()); shape=tuple(int(v) for v in rdr._actual_frame_shape())
        row=int(attrs.widthBytes or 0) or int(attrs.widthPx*attrs.componentCount*dtype.itemsize)
        inner=tuple(rdr._strides[1:]) if rdr._strides else np.empty(shape[1:],dtype).strides
        rows=range(0,int(attrs.heightPx),step); fh=rdr._fh; parts=[]
        for y in rows:
            fh.seek(int(off)+y*row); parts.append(fh.read(row))
        buf=b''.join(parts)
        if len(buf)<row*len(rows) or len(shape)<3 or shape[2]<count:raise LookupError
        a=np.ndarray(shape=(len(rows),)+shape[1:],dtype=dtype,buffer=buf,strides=(row,)+tuple(inner))
        return [np.ascontiguousarray(a[:,::step,c,...].reshape(len(rows),-1)) for c in range(count)]
    except Exception:
        frame=f.read_frame(int(seq_index)); sizes={str(k):int(v) for k,v in f.sizes.items()}
        return [np.ascontiguousarray(_select_channel(frame,c,count,int(sizes['Y']),int(sizes['X']))[::step,::step]) for c in range(count)]
def _colour_picture(planes,details,header=()):
    acc=None
    for plane,d in zip(planes,details):
        u=_scale_u8(np.ascontiguousarray(plane),.5,99.7).astype(np.float32)/255.0
        rgb=np.asarray(d.get('rgb') or [255,255,255],np.float32)/255.0
        layer=u[...,None]*rgb[None,None,:]
        acc=layer if acc is None else acc+layer
    out=np.clip(acc*255.0,0,255).astype(np.uint8); h,w=out.shape[:2]
    return _czi_struct.pack('<II'+'I'*len(header),w,h,*header)+out.tobytes()
def figure_nd2_point_thumb(path,position,max_side=320):
    """The middle Z plane of one point, every channel in its own colour, at most
    max_side pixels across: 8 bytes of width and height, then RGB rows."""
    f=_points_file(path); sizes={str(k):int(v) for k,v in f.sizes.items()}; count=int(sizes.get('C',f.attributes.channelCount or 1))
    step=max(1,int(np.ceil(max(int(sizes['Y']),int(sizes['X']))/float(max_side))))
    planes=_thin_planes(f,_frame_index(f,int(sizes.get('Z',1))//2,0,int(position)),count,step)
    return _colour_picture(planes,_channel_details(f,count))
def figure_nd2_point_view(path,position,max_side=1600,align=0):
    """One point enlarged: the maximum over its Z planes, as Image Prep shows it, at
    most max_side pixels across; with align, its Z planes lined up first (see
    _z_aligner; align=2 only when doubling is found). 12 bytes (width, height, the
    largest shift in pixels, 0 when nothing was moved), then RGB rows."""
    f=_points_file(path); sizes={str(k):int(v) for k,v in f.sizes.items()}; count=int(sizes.get('C',f.attributes.channelCount or 1))
    z_count=max(1,int(sizes.get('Z',1))); position=int(position)
    step=max(1,int(np.ceil(max(int(sizes['Y']),int(sizes['X']))/float(max_side)))); acc=None; moved=0.0
    aligner=_z_aligner(f,list(range(z_count)),0,position) if align and z_count>1 else None
    if aligner and int(align)==2 and aligner.check()<_ZA_DOUBLED:aligner=None
    if aligner:
        for zi in range(z_count):
            _notify('pixels',zi,z_count,f'Z {zi+1}/{z_count}')
            cur=[p[::step,::step] for p in aligner.planes(zi)]
            acc=[np.ascontiguousarray(p) for p in cur] if acc is None else [np.maximum(a,p) for a,p in zip(acc,cur)]
        moved=aligner.summary()['maxShift']
    else:
        for zi in range(z_count):
            cur=_thin_planes(f,_frame_index(f,zi,0,position),count,step)
            acc=cur if acc is None else [np.maximum(a,p) for a,p in zip(acc,cur)]
    return _colour_picture(acc,_channel_details(f,count),(int(round(moved)),))

def _select_channel(frame,channel_index,channel_count,y_size,x_size):
    frame=np.squeeze(np.asarray(frame))
    if frame.ndim==2:
        if channel_count==1 and channel_index==0:return frame
        raise RuntimeError(f'Unexpected single-plane frame shape {tuple(frame.shape)} for {channel_count} channels.')
    if frame.ndim>=3 and frame.shape[0]>=channel_count and tuple(frame.shape[-2:])==(y_size,x_size):plane=np.asarray(frame[channel_index])
    elif frame.ndim>=3 and frame.shape[-1]>=channel_count and tuple(frame.shape[:2])==(y_size,x_size):plane=np.asarray(frame[...,channel_index])
    else:raise RuntimeError(f'Unexpected ND2 frame shape {tuple(frame.shape)}.')
    plane=np.squeeze(plane)
    if plane.ndim!=2:raise RuntimeError(f'Channel did not resolve to 2D: {tuple(plane.shape)}')
    return plane

def _coord_axes(sizes):return [a for a in sizes if a not in ('C','Y','X','S')]
def _frame_index(f,z_index,time_index=0,position_index=0):
    sizes={str(k):int(v) for k,v in f.sizes.items()}; axes=_coord_axes(sizes); pos_axis='P' if 'P' in sizes else ('V' if 'V' in sizes else None); coords=[]
    for a in axes:
        if a=='Z':coords.append(int(z_index))
        elif a=='T':coords.append(int(time_index))
        elif a==pos_axis:coords.append(int(position_index))
        else:coords.append(0)
    seq_index=0; stride=1
    for a,c in zip(reversed(axes),reversed(coords)):seq_index+=int(c)*stride; stride*=int(sizes[a])
    return seq_index
def _stage_of(f,position=0,time=0):
    """Where a point was on the stage, [x, y] in micrometres (None if not recorded):
    from its first frame's own metadata, which a split one-point ND2 keeps, else from
    the file's list of points. Image Prep's Positions map draws it there."""
    try:
        p=f.frame_metadata(_frame_index(f,0,time,position)).channels[0].position.stagePositionUm
        if p is not None and np.isfinite(float(p.x)) and np.isfinite(float(p.y)):return [float(p.x),float(p.y)]
    except Exception:pass
    try:
        for lp in (getattr(f,'experiment',None) or []):
            if lp.type=='XYPosLoop':
                pts=list(lp.parameters.points)
                if 0<=int(position)<len(pts):
                    xyz=getattr(pts[int(position)],'stagePositionUm',None)
                    if xyz is not None and len(xyz)>=2:return [float(xyz[0]),float(xyz[1])]
    except Exception:pass
    return None
def _read_z_planes(f,z_index,time_index=0,position_index=0,channels=None):
    sizes={str(k):int(v) for k,v in f.sizes.items()}
    frame=f.read_frame(_frame_index(f,z_index,time_index,position_index)); attrs=f.attributes; count=int(sizes.get('C',attrs.channelCount or 1)); y=int(sizes['Y']); x=int(sizes['X']); channels=list(range(count)) if channels is None else channels
    return [_select_channel(frame,ch,count,y,x) for ch in channels]

# ── Lining up Z planes ────────────────────────────────────────────────────────
# A stitched confocal point (a large image made of tiles) can have its Z planes
# shifted a few pixels against each other, by a different amount in each tile, so
# their maximum shows every cell and fibre twice. Each plane is compared with the
# middle plane in overlapping 256-pixel squares (phase correlation of all channels
# together, on a 2x2-binned copy, the peak placed to a fraction of a pixel);
# squares without enough tissue, or with no clear match, take their neighbours'
# shift; a 3x3 median drops single wrong squares. The shift between square centres
# is interpolated, rounded to whole pixels, and each plane is moved by it: pixels
# are moved, never resampled, so every value stays as recorded (pixels moved in
# from outside the image are 0). The same shifts (the "field") are handed to the
# raw exports, which move the planes identically.
_ZA_BLOCK=256
def _za_signal(planes):
    acc=None
    for p in planes:
        a=np.asarray(p,np.float32); m=float(a.mean()) or 1.0
        acc=a/m if acc is None else acc+a/m
    return acc
def _za_bin(a):
    H,W=a.shape; H2,W2=H//2*2,W//2*2
    return a[:H2,:W2].reshape(H2//2,2,W2//2,2).mean(axis=(1,3))
def _za_measure(mov,ref,B=_ZA_BLOCK,step=1):
    """The shift of mov against ref in each square, measured on 2x2-binned copies
    (four times faster) with the peak placed to a fraction of a pixel, in full-
    resolution pixels; ok marks the squares that were measured."""
    mov=_za_bin(mov); ref=_za_bin(ref); H,W=ref.shape; B=int(min(B//2,H,W)); S=max(1,B//2)
    ys=list(range(0,max(0,H-B)+1,S)); xs=list(range(0,max(0,W-B)+1,S))
    if ys[-1]!=H-B:ys.append(H-B)
    if xs[-1]!=W-B:xs.append(W-B)
    win=(np.hanning(B)[:,None]*np.hanning(B)[None,:]).astype(np.float32); limit=B//3
    grid=np.zeros((len(ys),len(xs),2),np.float32); ok=np.zeros((len(ys),len(xs)),bool)
    lvl=float(np.percentile(ref,50)); spread=float(np.percentile(ref,99))-lvl
    boxes=[(j,i,y,x) for j,y in enumerate(ys) for i,x in enumerate(xs) if ref[y:y+B,x:x+B].std()>0.05*spread][::max(1,int(step))]
    def frac(a,b,d):
        den=a-2*b+d
        return 0.0 if den>=0 else 0.5*(a-d)/den
    for k in range(0,len(boxes),32):
        part=boxes[k:k+32]
        r=np.stack([ref[y:y+B,x:x+B] for _,_,y,x in part]); m=np.stack([mov[y:y+B,x:x+B] for _,_,y,x in part])
        r=(r-r.mean(axis=(1,2),keepdims=True))*win; m=(m-m.mean(axis=(1,2),keepdims=True))*win
        X=np.fft.rfft2(r)*np.conj(np.fft.rfft2(m)); X/=np.abs(X)+1e-6
        c=np.fft.irfft2(X,s=(B,B)); flat=c.reshape(len(part),-1)
        for n,((j,i,_,_),ix,pk,nz) in enumerate(zip(part,flat.argmax(1),flat.max(1),flat.std(1))):
            py,px=divmod(int(ix),B); cc=c[n]
            dy=py-B if py>B//2 else py; dx=px-B if px>B//2 else px
            if pk>6*nz and abs(dy)<=limit and abs(dx)<=limit:
                fy=frac(cc[(py-1)%B,px],cc[py,px],cc[(py+1)%B,px]); fx=frac(cc[py,(px-1)%B],cc[py,px],cc[py,(px+1)%B])
                grid[j,i]=(2*(dy+fy),2*(dx+fx)); ok[j,i]=True
    return grid,ok,[2.0*y+B for y in ys],[2.0*x+B for x in xs]
def _za_fill(grid,ok):
    g=grid.copy(); have=ok.copy()
    if not have.any():return np.zeros_like(g)
    while not have.all():
        nxt=have.copy()
        for j,i in zip(*np.where(~have)):
            sl=(slice(max(0,j-1),j+2),slice(max(0,i-1),i+2)); n=have[sl]
            if n.any():g[j,i]=np.median(g[sl][n],axis=0); nxt[j,i]=True
        have=nxt
    out=g.copy(); J,I=g.shape[:2]
    for j in range(J):
        for i in range(I):out[j,i]=np.median(g[max(0,j-1):j+2,max(0,i-1):i+2].reshape(-1,2),axis=0)
    return out
def _za_weights(n,centers):
    c=np.asarray(centers,np.float64); x=np.arange(n,dtype=np.float64); w=np.zeros((n,len(c)),np.float32)
    if len(c)==1:
        w[:,0]=1;return w
    j=np.clip(np.searchsorted(c,x)-1,0,len(c)-2); t=np.clip((x-c[j])/(c[j+1]-c[j]),0,1)
    w[np.arange(n),j]=1-t; w[np.arange(n),j+1]+=t
    return w
def _za_index(field,H,W):
    """For each pixel, the flat index of the pixel moved there (-1: from outside)."""
    g=np.asarray(field['g'],np.float32); wy=_za_weights(H,field['cy']); wx=_za_weights(W,field['cx'])
    dy=np.rint(wy@g[...,0]@wx.T).astype(np.int32); dx=np.rint(wy@g[...,1]@wx.T).astype(np.int32)
    yy=np.arange(H,dtype=np.int32)[:,None]-dy; xx=np.arange(W,dtype=np.int32)[None,:]-dx
    return np.where((yy>=0)&(yy<H)&(xx>=0)&(xx<W),yy*W+xx,-1)
def _za_apply(plane,index):
    out=np.asarray(plane).ravel()[np.maximum(index,0)].reshape(index.shape); out[index<0]=0
    return out
# Doubling is looked for before anything is moved: a layer whose squares are
# shifted by a median of _ZA_DOUBLED pixels or more against the middle layer.
# Stacks with doubling measured 3.7-8.9 px in their worst layer; the same stacks
# lined up, at most 0.3 px.
_ZA_DOUBLED=1.0
def _za_detect(mov,ref):
    """A quick look (every fourth square) at how far mov is shifted against ref:
    the median shift in pixels over the squares with tissue (0 with fewer than 4)."""
    g,ok,_,_=_za_measure(mov,ref,step=4)
    return float(np.median(np.hypot(g[...,0],g[...,1])[ok])) if ok.sum()>=4 else 0.0
class _z_aligner:
    """The Z planes of one point lined up with its middle chosen plane."""
    def __init__(self,f,z_indices,time,position):
        self.f=f; self.t=int(time); self.p=int(position); self.z=list(z_indices); self.ref=self.z[len(self.z)//2]
        self.ref_planes=_read_z_planes(f,self.ref,self.t,self.p); self.ref_sig=_za_signal(self.ref_planes); self.fields={}
    def planes(self,z,channels=None):
        """Every channel (or these) of Z plane z, moved into line."""
        cur=self.ref_planes if z==self.ref else _read_z_planes(self.f,z,self.t,self.p)
        pick=lambda xs:xs if channels is None else [xs[c] for c in channels]
        if z==self.ref:return pick(cur)
        g,ok,cy,cx=_za_measure(_za_signal(cur),self.ref_sig); g=_za_fill(g,ok)
        field={'g':g.tolist(),'cy':cy,'cx':cx,'measured':float(ok.mean())}; self.fields[str(int(z))]=field
        H,W=cur[0].shape; idx=_za_index(field,H,W)
        return [_za_apply(p,idx) for p in pick(cur)]
    def check(self):
        """How doubled the stack looks: the largest median shift of any layer against
        the reference, from a quick look (_za_detect). Nothing is moved."""
        return max([_za_detect(_za_signal(_read_z_planes(self.f,z,self.t,self.p)),self.ref_sig) for z in self.z if z!=self.ref] or [0.0])
    def summary(self):
        moved=max([float(np.abs(np.asarray(v['g'])).max()) for v in self.fields.values()] or [0.0])
        return {'ref':int(self.ref),'block':_ZA_BLOCK,'fields':self.fields,'maxShift':moved}

def _percentile_pair(x,lo_pct,hi_pct):
    dt=x.dtype
    if dt==np.uint8:hist=np.bincount(x.ravel(),minlength=256);offset=0
    elif dt==np.uint16:hist=np.bincount(x.ravel(),minlength=65536);offset=0
    elif dt==np.int8:hist=np.bincount(x.ravel().astype(np.int32)+128,minlength=256);offset=-128
    elif dt==np.int16:hist=np.bincount(x.ravel().astype(np.int32)+32768,minlength=65536);offset=-32768
    else:return float(np.percentile(x,lo_pct)),float(np.percentile(x,hi_pct))
    cum=np.cumsum(hist); total=int(x.size); out=[]
    for q in (lo_pct,hi_pct):
        pos=(float(q)/100.0)*(total-1); i0=int(np.floor(pos)); i1=int(np.ceil(pos)); frac=pos-i0; v0=int(np.searchsorted(cum,i0+1,side='left')); v1=v0 if i1==i0 else int(np.searchsorted(cum,i1+1,side='left')); out.append(float((v0+offset)+frac*(v1-v0)))
    return out[0],out[1]
def _apply_scale(x,lo,hi):
    dt=x.dtype
    if dt==np.uint8 or dt==np.uint16:
        size=256 if dt==np.uint8 else 65536; dom=_SCALE_DOMAIN.get(size)
        if dom is None:dom=np.arange(size,dtype=dt);_SCALE_DOMAIN[size]=dom
        lut=np.clip((dom.astype(np.float32,copy=False)-lo)*(255.0/(hi-lo)),0,255).astype(np.uint8);return lut[x]
    return np.clip((x.astype(np.float32,copy=False)-lo)*(255.0/(hi-lo)),0,255).astype(np.uint8)
def _scale_u8(a,lo_pct=.2,hi_pct=99.8,with_range=False,fixed=None):
    # with_range also returns the raw intensities mapped to 0 and 255, so Image
    # Prep can label its histogram in microscope units (as Fiji's B&C does).
    x=np.asarray(a); finite=x[np.isfinite(x)] if np.issubdtype(x.dtype,np.floating) else x
    if finite.size==0:
        z=np.zeros(x.shape,np.uint8);return (z,None) if with_range else z
    if fixed is not None:
        # A fixed raw range (full camera range, or the range used for another file) so
        # that equal settings mean equal display across files, as with Fiji's "Set".
        lo,hi=float(fixed[0]),float(fixed[1])
    else:
        lo,hi=_percentile_pair(finite,lo_pct,hi_pct);lo=float(np.min(finite)) if not np.isfinite(lo) else lo;hi=float(np.max(finite)) if not np.isfinite(hi) else hi
    if hi<=lo:hi=lo+1.0
    out=_apply_scale(x,lo,hi)
    if not with_range:return out
    return out,{'lo':lo,'hi':hi,'dataMin':float(np.min(finite)),'dataMax':float(np.max(finite))}
def _downsample_area_u8(a,max_dimension):
    # Display-preview resampling only. The native-resolution MaxIP has already
    # been computed and mapped to uint8 above. Use block-area averaging here so
    # reducing a preview preserves mean brightness instead of selecting the
    # brightest pixel from every block (which made small previews look brighter
    # than the high-resolution preview when the size slider crossed the HQ
    # threshold).
    x=np.asarray(a);h,w=x.shape
    if not max_dimension or max(h,w)<=int(max_dimension):return np.ascontiguousarray(x)
    factor=max(1,int(np.ceil(max(h,w)/float(max_dimension))))
    nh=(h+factor-1)//factor;nw=(w+factor-1)//factor
    ph=nh*factor-h;pw=nw*factor-w
    work=np.pad(x,((0,ph),(0,pw)),mode='constant',constant_values=0) if (ph or pw) else x
    sums=work.astype(np.uint64,copy=False).reshape(nh,factor,nw,factor).sum(axis=(1,3),dtype=np.uint64)
    row_counts=np.minimum(factor,h-np.arange(nh)*factor).astype(np.uint64)
    col_counts=np.minimum(factor,w-np.arange(nw)*factor).astype(np.uint64)
    counts=row_counts[:,None]*col_counts[None,:]
    out=np.rint(sums/counts).clip(0,255).astype(np.uint8)
    return np.ascontiguousarray(out)

def figure_render_channels(path,time=0,position=0,z_mode='max',z_index=0,max_dimension=0,channels_json='[]',outdir='/tmp/figure_nd2',ranges_json='null',z_layers_json='null',z_align=0):
    # z_layers_json: the Z layers (from 0) the maximum is taken over; null is every layer.
    # z_align: line the Z layers up first (_z_aligner); the shifts used come back as zAlign.
    # z_align=2 looks for doubling first and lines up only when it finds some; what it
    # found comes back as zCheck.
    z_layers=json.loads(z_layers_json or 'null');channels=[int(x) for x in json.loads(channels_json)]; fixed_ranges=json.loads(ranges_json or 'null') or [None]*len(channels); time=int(time);position=int(position);z_index=int(z_index);max_dimension=int(max_dimension or 0)
    if not channels:raise RuntimeError('Select at least one channel.')
    if os.path.isdir(outdir):shutil.rmtree(outdir)
    os.makedirs(outdir,exist_ok=True)
    with _open_microscopy(path) as f:
        if f.is_legacy:raise RuntimeError('Legacy JPEG-2000 ND2 pixel decoding is not supported in this browser build.')
        if f.is_rgb:raise RuntimeError('RGB-component ND2 or CZI (a colour brightfield scan) is not supported; expected separate monochrome channels.')
        info=_info_dict(f,os.path.basename(path));z_count=max(1,int(info['zCount']))
        if time<0 or time>=info['counts']['time']:raise RuntimeError('Time index is out of range.')
        if position<0 or position>=info['counts']['position']:raise RuntimeError('Position index is out of range.')
        if z_mode=='slice' and (z_index<0 or z_index>=z_count):raise RuntimeError('Z slice is out of range.')
        # Project at the ND2's native XY resolution first. The previous path
        # downsampled every Z plane before MaxIP, permanently discarding spatial
        # detail and making later insets visibly softer than Fiji.
        accum=None
        z_indices=[z_index] if z_mode=='slice' else list(range(z_count))
        if z_mode!='slice' and z_layers:
            z_indices=sorted({int(z) for z in z_layers if 0<=int(z)<z_count}) or z_indices
        aligner=_z_aligner(f,z_indices,time,position) if z_align and len(z_indices)>1 else None
        checked=None
        if aligner and int(z_align)==2:
            _notify('pixels',0,len(z_indices),'Checking Z layers for doubling')
            checked=aligner.check()
            if checked<_ZA_DOUBLED:aligner=None
        for zi_pos,zi in enumerate(z_indices):
            _notify('pixels',zi_pos,len(z_indices),f'Z {zi+1}/{z_count}'+(' (lining up)' if aligner else ''))
            cur=aligner.planes(zi,channels) if aligner else _read_z_planes(f,zi,time,position,channels)
            if accum is None:accum=[x.copy() for x in cur]
            else:
                for target,plane in zip(accum,cur):np.maximum(target,plane,out=target)
        _notify('pixels',len(z_indices),len(z_indices),'Projection complete')
        # Map microscope intensities once, at native spatial resolution. PNG is
        # lossless after this display mapping. Reduced modes only create a
        # lighter on-canvas copy; the native-size mapped plane is retained as
        # the backing source for Image Prep and inset crops.
        full_scaled=[];raw_ranges=[]
        for i,a in enumerate(accum):
            fx=fixed_ranges[i] if i<len(fixed_ranges) else None
            scaled,rng=_scale_u8(a,with_range=True,fixed=fx)
            if rng is not None:
                # Pixels at the camera's maximum were saturated at acquisition.
                bits=int(info.get('bitsSignificant') or 0) or int(info.get('bitsInMemory') or 0)
                cam_max=float(2**bits-1) if bits and np.issubdtype(a.dtype,np.integer) else float(np.max(a))
                rng['cameraMax']=cam_max;rng['saturated']=float(np.count_nonzero(a>=cam_max))/float(a.size) if a.size else 0.0;rng['mode']='fixed' if fx is not None else 'auto'
            full_scaled.append(scaled);raw_ranges.append(rng);_notify('scale',i+1,len(accum),f'Channel {i+1}/{len(accum)}')
        full_h,full_w=full_scaled[0].shape
        display_scaled=[_downsample_area_u8(a,max_dimension) for a in full_scaled] if max_dimension else full_scaled
        for i,a in enumerate(display_scaled):a.tofile(os.path.join(outdir,f'ch_{channels[i]}.bin'))
        for i,a in enumerate(full_scaled):a.tofile(os.path.join(outdir,f'full_ch_{channels[i]}.bin'))
        return json.dumps({'width':int(display_scaled[0].shape[1]),'height':int(display_scaled[0].shape[0]),'fullWidth':int(full_w),'fullHeight':int(full_h),'channels':channels,'files':[f'ch_{x}.bin' for x in channels],'fullFiles':[f'full_ch_{x}.bin' for x in channels],'rawRanges':raw_ranges,'info':info,'zAlign':aligner.summary() if aligner else None,'zCheck':None if checked is None else {'shift':checked,'doubled':checked>=_ZA_DOUBLED},'stage':_stage_of(f,position,time)})
