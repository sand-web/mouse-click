// Local-only native-input oracle. It never sends or synthesizes input to the app.
const http = require('node:http');
const states = new Map();
const html = `<!doctype html><meta charset="utf-8"><title>Mouse Click Reading Fixture</title>
<style>
body{font:20px system-ui;background:#faf9f6;color:#182c29;margin:30px}main{max-width:1000px;margin:auto}h1{font-size:30px;margin:0 0 14px}button,input{font:20px system-ui;padding:12px;margin:8px 16px 8px 0}input{width:420px}#selection-target{font:24px monospace;white-space:pre;user-select:text}#reader{height:310px;overflow-y:scroll;border:3px solid #21816d;padding:0 24px;background:white}#reader p{line-height:1.6}#reader::-webkit-scrollbar{width:24px}#reader::-webkit-scrollbar-track{background:#d9e9e2}#reader::-webkit-scrollbar-thumb{background:#21816d;border:3px solid #d9e9e2;border-radius:12px}#status{font-size:16px;color:#526963}
</style><main><h1>Mouse Click · 正常阅读验收</h1><p>这是本地测试页，验证光圈开启后的真实鼠标操作。</p>
<button id="test-button">点击验证：0</button><input id="keyboard-target" aria-label="键盘焦点验证" placeholder="点击后输入测试文字">
<p><span id="selection-target">Mouse Click reading test.</span></p><p id="status">等待操作</p>
<div id="reader" tabindex="0" aria-label="可滚动阅读区"></div></main>
<script>
const phase=new URL(location.href).searchParams.get('phase')||'default';
const reader=document.querySelector('#reader');
for(let i=1;i<=80;i++){const p=document.createElement('p');p.textContent='第 '+i+' 段：正常滚动、翻页和选字时，光圈大小应保持固定。 Reading paragraph '+i+'.';reader.append(p);}
let clicks=0;const events=[];
function rect(id){const r=document.getElementById(id).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};}
function snapshot(){return {phase,at:Date.now(),focus:document.hasFocus(),activeId:document.activeElement.id,clicks,input:document.getElementById('keyboard-target').value,selection:String(getSelection()),scrollTop:reader.scrollTop,scrollHeight:reader.scrollHeight,clientHeight:reader.clientHeight,events:[...events],rects:Object.fromEntries(['test-button','keyboard-target','selection-target','reader'].map(id=>[id,rect(id)])),viewport:{width:innerWidth,height:innerHeight,screenX,screenY,outerWidth,outerHeight,dpr:devicePixelRatio}};}
function publish(){fetch('/events',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(snapshot()),keepalive:true}).catch(()=>{});}
function event(e){events.push({type:e.type,trusted:e.isTrusted,target:e.target.id,at:Date.now(),deltaY:e.deltaY,clientX:e.clientX,clientY:e.clientY});if(events.length>100)events.shift();publish();}
document.getElementById('test-button').addEventListener('click',e=>{clicks++;e.currentTarget.textContent='点击验证：'+clicks;document.querySelector('#status').textContent='已点击 '+clicks+' 次';event(e)});
for(const type of ['wheel','mousedown','mouseup','input','selectionchange'])document.addEventListener(type,event,{passive:true});
reader.addEventListener('scroll',event);window.addEventListener('blur',publish);window.addEventListener('focus',publish);setInterval(publish,200);publish();
</script>`;
const server = http.createServer((req,res)=>{
  const url = new URL(req.url,'http://127.0.0.1');
  if(req.method==='POST'&&url.pathname==='/events'){
    let body='';req.on('data',chunk=>{body+=chunk;if(body.length>65536)req.destroy()});req.on('end',()=>{try{const value=JSON.parse(body);states.set(value.phase,value);res.writeHead(204);res.end()}catch{res.writeHead(400);res.end()}});return;
  }
  if(req.method==='GET'&&url.pathname==='/state'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(states.get(url.searchParams.get('phase')||'default')||null));return;}
  if(req.method==='GET'&&url.pathname==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);return;}
  res.writeHead(404);res.end();
});
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({pid:process.pid,url:'http://127.0.0.1:'+server.address().port,scope:'dummy reading fixture; loopback only'})));
