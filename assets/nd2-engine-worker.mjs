/* Persistent shared ND2 engine. One Pyodide/NumPy/nd2 runtime serves all toolkit pages. */
/* Written as ../assets/ so the release build versions it (?h=): this worker
   always gets the toolkit-core.js it was built with, never a cached older copy
   (see ToolkitCore.nd2.engineWorkerUrlForPage). A static import: in Chrome, a
   shared worker's import() of toolkit-core.js failed to load. */
import '../assets/toolkit-core.js';
const ToolkitCore=globalThis.ToolkitCore;

const ENGINE_ID=(self.crypto?.randomUUID?.()||('nd2-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2)));
const ports=new Set();
const portClients=new Map();
const helperNamespaces=new Map();
let pyodide=null;
let initPromise=null;
let queue=Promise.resolve();
let status={state:'idle',phase:'idle',fraction:0,label:'ND2 engine waiting',engineId:ENGINE_ID};
let activeRequest=null;

function post(port,msg,transfer){try{port.postMessage(msg,transfer||[])}catch{}}
function broadcastStatus(patch){status={...status,...patch};for(const port of ports)post(port,{type:'status',status})}
function emitProgress(kind,phase,done,total,detail){
  if(!activeRequest)return;
  post(activeRequest.port,{type:'progress',progress:{kind,phase:String(phase||''),done:Number(done)||0,total:Number(total)||0,fraction:Number(total)?Number(done)/Number(total):0,detail:String(detail||'')}});
}
self.figureNd2Progress=(phase,done,total,detail)=>emitProgress('figure',phase,done,total,detail);
self.nd2Progress=(phase,done,total,detail)=>emitProgress('slide',phase,done,total,detail);

async function bootWorkerPyodide(){
  if(!('WebAssembly' in self))throw new Error('WebAssembly is unavailable in this browser context.');
  let last=null;
  for(const base of ToolkitCore.nd2.pyodideBases){
    try{
      broadcastStatus({state:'warming',phase:'runtime',fraction:.03,label:'Loading shared Pyodide runtime…'});
      // Pyodide 314 requires a module-type worker. Load the official ESM entry
      // point: the site's own pinned copy first, the CDN release as a fallback.
      const mod=await Promise.race([
        import(base+'pyodide.mjs'),
        new Promise((_,reject)=>setTimeout(()=>reject(new Error('Pyodide module loader timed out.')),30000))
      ]);
      if(typeof mod.loadPyodide!=='function')throw new Error('Pyodide module did not export loadPyodide().');
      const py=await Promise.race([
        (typeof ToolkitCore.nd2.pyodideOptions==='function'?ToolkitCore.nd2.pyodideOptions(base):Promise.resolve({indexURL:base})).then(opts=>mod.loadPyodide(opts)),
        new Promise((_,reject)=>setTimeout(()=>reject(new Error('Pyodide runtime timed out.')),120000))
      ]);
      broadcastStatus({state:'warming',phase:'numpy',fraction:.38,label:'Loading NumPy and the ND2 reader…'});
      await ToolkitCore.nd2.loadNd2Packages(py,base);
      return {pyodide:py,base};
    }catch(error){
      last=error;
      // Try the next pinned base only if one is configured.
    }
  }
  throw last||new Error('Could not initialize the shared Pyodide/ND2 runtime.');
}

/* Zeiss CZI: tiles may be Zstd- (ZEN 3.x) or JPEG XR-compressed (Axioscan). Both
   decoders are loaded only when a CZI is opened: Pyodide's zstandard, and jxrlib built
   for the browser (assets/vendor/jpegxr-0.3.0.js, BSD), exposed to the Python reader as
   a synchronous cziJxrDecode(bytes) -> raw pixels. */
let cziReady=null;
self.cziPrepare=()=>{
  if(!cziReady)cziReady=(async()=>{
    const py=await ensureRuntime();
    await py.loadPackage(['zstandard']);
    const text=await (await fetch(new URL('./vendor/jpegxr-0.3.0.js',import.meta.url))).text();
    const codec=await (new Function(text+'\n;return jpegxr;')())();
    self.cziJxrDecode=bytes=>codec.decode(bytes).bytes;
  })().catch(error=>{cziReady=null;throw error});
  return cziReady;
};
async function ensureRuntime(){
  if(pyodide)return pyodide;
  if(initPromise)return initPromise;
  initPromise=(async()=>{
    try{
      const boot=await bootWorkerPyodide();
      pyodide=boot.pyodide;
      broadcastStatus({state:'warming',phase:'verify',fraction:.9,label:'Priming shared ND2 engine…'});
      await pyodide.runPythonAsync('import numpy as np\nimport nd2\n_ = np.zeros((8,8), dtype=np.uint16).max(axis=0)');
      broadcastStatus({state:'ready',phase:'ready',fraction:1,label:'Shared ND2 engine ready',base:boot.base});
      return pyodide;
    }catch(error){
      initPromise=null;pyodide=null;
      const detail=String(error?.stack||error?.message||error);
      broadcastStatus({state:'error',phase:'error',fraction:0,label:'Shared ND2 engine failed',error:detail});
      throw error;
    }
  })();
  return initPromise;
}

function namespaceId(clientId,helperId){return `${clientId}::${helperId}`}
async function ensureHelper(clientId,helperId,source){
  const py=await ensureRuntime(),key=namespaceId(clientId,helperId);
  let item=helperNamespaces.get(key);
  if(item&&item.source===source)return item.ns;
  if(item?.ns?.destroy)try{item.ns.destroy()}catch{}
  const ns=py.runPython('{}');
  const srcPy=py.toPy(String(source));
  try{
    py.globals.set('_tk_rpc_ns',ns);py.globals.set('_tk_rpc_source',srcPy);
    await py.runPythonAsync('exec(_tk_rpc_source, _tk_rpc_ns)');
  }finally{
    try{py.globals.delete('_tk_rpc_ns');py.globals.delete('_tk_rpc_source')}catch{}
    try{srcPy.destroy?.()}catch{}
  }
  helperNamespaces.set(key,{ns,source});
  return ns;
}

function setGlobals(py,ns,globals){
  const created=[];
  for(const [k,v] of Object.entries(globals||{})){
    const pv=py.toPy(v);created.push(pv);ns.set(k,pv);
  }
  return()=>{
    for(const k of Object.keys(globals||{}))try{ns.delete(k)}catch{}
    for(const pv of created)try{pv?.destroy?.()}catch{}
  };
}
function resultToJs(result){
  if(result==null||typeof result==='string'||typeof result==='number'||typeof result==='boolean')return result;
  if(result instanceof Uint8Array||result instanceof ArrayBuffer||ArrayBuffer.isView(result))return result;
  if(typeof result.toJs==='function'){
    try{return result.toJs({dict_converter:entries=>Object.fromEntries(entries)})}
    finally{try{result.destroy?.()}catch{}}
  }
  return result;
}
function transferables(value,out=[]){
  if(value instanceof ArrayBuffer){out.push(value);return out}
  if(ArrayBuffer.isView(value)){out.push(value.buffer);return out}
  if(Array.isArray(value)){for(const v of value)transferables(v,out);return out}
  if(value&&typeof value==='object'){for(const v of Object.values(value))transferables(v,out)}
  return [...new Set(out)];
}
async function evaluateInNamespace(clientId,helperId,code,globals,mode){
  const py=await ensureRuntime(),key=namespaceId(clientId,helperId),item=helperNamespaces.get(key);
  if(!item)throw new Error(`ND2 helper '${helperId}' is not loaded for this tool.`);
  const ns=item.ns,cleanup=setGlobals(py,ns,globals);
  const codePy=py.toPy(String(code));
  try{
    py.globals.set('_tk_rpc_ns',ns);py.globals.set('_tk_rpc_code',codePy);
    const result=await py.runPythonAsync(mode==='exec'?'exec(_tk_rpc_code, _tk_rpc_ns)':'eval(_tk_rpc_code, _tk_rpc_ns)');
    return resultToJs(result);
  }finally{
    cleanup();try{codePy.destroy?.()}catch{};try{py.globals.delete('_tk_rpc_ns');py.globals.delete('_tk_rpc_code')}catch{}
  }
}
async function evaluateGlobal(code,globals,mode){
  const py=await ensureRuntime(),cleanup=setGlobals(py,py.globals,globals);
  try{
    // Use Pyodide's own async compiler here so top-level `await` (micropip installs)
    // keeps working exactly as it did in the page-local runtimes.
    const result=await py.runPythonAsync(String(code));
    return resultToJs(result);
  }finally{cleanup()}
}
// A browser File is mounted read-only (WORKERFS) instead of copied into memory: the
// reader then fetches only the bytes it asks for, so a multi-gigabyte ND2 opens without
// the whole file having to fit in the engine's memory (copying a 6 GB file failed outright).
// The path asked for becomes a link to the mounted file; unlinking it unmounts.
const fileMounts=new Map();let mountSeq=0;
function releaseMount(path){const dir=fileMounts.get(path);if(!dir)return;fileMounts.delete(path);try{pyodide.FS.unlink(path)}catch{};try{pyodide.FS.unmount(dir)}catch{};try{pyodide.FS.rmdir(dir)}catch{}}
function mountBrowserFile(path,file){
  if(!file||typeof file.slice!=='function')throw new Error('No file to mount.');
  const WORKERFS=pyodide.FS.filesystems?.WORKERFS;
  if(!WORKERFS||typeof FileReaderSync==='undefined')return {mounted:false};
  releaseMount(path);
  const dir=`/tk_mount_${++mountSeq}`;
  try{pyodide.FS.mkdir(dir);pyodide.FS.mount(WORKERFS,{files:[file]},dir);
    mkdirParent(path);try{pyodide.FS.unlink(path)}catch{};pyodide.FS.symlink(`${dir}/${file.name}`,path);
    fileMounts.set(path,dir);return {mounted:true,size:file.size};
  }catch(err){try{pyodide.FS.unmount(dir)}catch{};try{pyodide.FS.rmdir(dir)}catch{};return {mounted:false,error:String(err?.message||err)}}
}
function mkdirParent(path){const slash=String(path).lastIndexOf('/');if(slash>0)try{pyodide.FS.mkdirTree(String(path).slice(0,slash))}catch{}}
async function handleRpc(port,msg){
  const {id,clientId,op,payload={}}=msg;
  activeRequest={port,id,clientId};
  try{
    let value=null;
    if(op==='init'){await ensureRuntime();value={ready:true,status,engineId:ENGINE_ID}}
    else if(op==='ensureHelper'){await ensureHelper(clientId,payload.helperId,payload.source);value=true}
    else if(op==='run'){value=await evaluateInNamespace(clientId,payload.helperId,payload.code,payload.globals,payload.mode||'eval')}
    else if(op==='runGlobal'){value=await evaluateGlobal(payload.code,payload.globals,payload.mode||'exec')}
    else if(op==='writeFile'){await ensureRuntime();const path=String(payload.path);releaseMount(path);mkdirParent(path);try{pyodide.FS.unlink(path)}catch{};pyodide.FS.writeFile(path,new Uint8Array(payload.buffer));value=true}
    else if(op==='mountFile'){await ensureRuntime();value=mountBrowserFile(String(payload.path),payload.file)}
    else if(op==='readFile'){await ensureRuntime();const view=pyodide.FS.readFile(String(payload.path));value=new Uint8Array(view)}
    else if(op==='unlink'){await ensureRuntime();try{pyodide.FS.unlink(String(payload.path))}catch{};releaseMount(String(payload.path));value=true}
    else if(op==='mkdirTree'){await ensureRuntime();pyodide.FS.mkdirTree(String(payload.path));value=true}
    else if(op==='exists'){await ensureRuntime();try{pyodide.FS.stat(String(payload.path));value=true}catch{value=false}}
    else throw new Error(`Unknown ND2 worker operation: ${op}`);
    const xfer=transferables(value);post(port,{type:'rpc-result',id,ok:true,value},xfer);
  }catch(error){post(port,{type:'rpc-result',id,ok:false,error:String(error?.stack||error?.message||error)})}
  finally{activeRequest=null}
}
function attachPort(port){
  ports.add(port);port.start?.();post(port,{type:'status',status});
  port.onmessage=e=>{
    const msg=e.data||{};
    if(msg.type==='attach'){
      portClients.set(port,msg.clientId||'');
      if(msg.start)ensureRuntime().catch(()=>{});
      post(port,{type:'status',status});
    }else if(msg.type==='detach'){
      const cid=msg.clientId||portClients.get(port)||'';
      for(const [key,item] of [...helperNamespaces])if(key.startsWith(cid+'::')){try{item.ns?.destroy?.()}catch{};helperNamespaces.delete(key)}
      portClients.delete(port);ports.delete(port);
    }else if(msg.type==='rpc'){
      queue=queue.then(()=>handleRpc(port,msg),()=>handleRpc(port,msg));
    }
  };
}

if('onconnect' in self){
  self.onconnect=e=>attachPort(e.ports[0]);
}else{
  // Dedicated-worker fallback for browsers without SharedWorker. It cannot persist across navigation.
  const shim={postMessage:(m,t)=>self.postMessage(m,t),start(){},set onmessage(fn){self.onmessage=fn}};
  attachPort(shim);
}
