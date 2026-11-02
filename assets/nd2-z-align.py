# Lining up Z planes, for tools that hold the whole stack in memory (Soma).
# A stitched confocal point (a large image made of tiles) can have its Z planes
# shifted a few pixels against each other, by a different amount in each tile, so
# their maximum shows every cell and fibre twice. Each plane is compared with the
# middle plane in overlapping 256-pixel squares (phase correlation of all channels
# together, on a 2x2-binned copy, the peak placed to a fraction of a pixel);
# squares without enough tissue, or with no clear match, take their neighbours'
# shift; a 3x3 median drops single wrong squares. The shift between square centres
# is interpolated, rounded to whole pixels, and each plane is moved by it: pixels
# are moved, never resampled, so every value stays as recorded (pixels moved in
# from outside the image are 0).
# The _za_ functions are the same code as in nd2-display-helper.py (Image Prep and
# Figure Workshop) and nd2-raw-export.py, so every tool lines a stack up the same
# way; tests/test_z_align.py checks that they stay identical.
import numpy as np
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
def za_max_aligned(plane,zs):
    """The maximum over Z layers zs of every channel, each layer first moved into
    line with the middle one. plane(z) gives all channels of layer z. Returns the
    channel maxima and a summary like Image Prep's ({ref, block, fields, maxShift})."""
    zs=[int(z) for z in zs]; ref=zs[len(zs)//2]; ref_planes=plane(ref); ref_sig=_za_signal(ref_planes)
    out=[np.array(p,copy=True) for p in ref_planes]; fields={}
    for z in zs:
        if z==ref:continue
        cur=plane(z)
        g,ok,cy,cx=_za_measure(_za_signal(cur),ref_sig); g=_za_fill(g,ok)
        field={'g':g.tolist(),'cy':cy,'cx':cx,'measured':float(ok.mean())}; fields[str(z)]=field
        H,W=cur[0].shape; idx=_za_index(field,H,W)
        for o,p in zip(out,cur):np.maximum(o,_za_apply(p,idx),out=o)
    moved=max([float(np.abs(np.asarray(v['g'])).max()) for v in fields.values()] or [0.0])
    return out,{'ref':ref,'block':_ZA_BLOCK,'fields':fields,'maxShift':moved}
def za_check(plane,zs):
    """How doubled the stack looks, before anything is moved: the largest median
    shift of any layer against the middle one (_za_detect; _ZA_DOUBLED or more is
    doubling)."""
    zs=[int(z) for z in zs]; ref=zs[len(zs)//2]; rs=_za_signal(plane(ref))
    return max([_za_detect(_za_signal(plane(z)),rs) for z in zs if z!=ref] or [0.0])
