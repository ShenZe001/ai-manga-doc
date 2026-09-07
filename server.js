const express = require("express");
const session = require("express-session");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change-me";
const SESSION_SECRET = process.env.SESSION_SECRET || "change-this-secret";
const STORAGE_ROOT = process.env.STORAGE_DIR || path.join(__dirname, "storage");
const DATA_FILE = path.join(STORAGE_ROOT, "documents.json");
const UPLOAD_DIR = path.join(STORAGE_ROOT, "uploads");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, "[]", "utf8");

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 12
  }
}));

function readDocs() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch { return []; }
}
function writeDocs(docs) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(docs, null, 2), "utf8");
}
function clean(v, max=300) {
  return String(v || "").trim().slice(0, max);
}
function adminOnly(req,res,next){
  if(req.session?.isAdmin) return next();
  res.status(401).json({error:"未登录或登录已过期"});
}
function esc(s=""){
  return String(s).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));
}

const allowed = new Set([".pdf",".doc",".docx",".ppt",".pptx",".xls",".xlsx",".zip",".rar",".7z",".txt"]);
const upload = multer({
  storage: multer.diskStorage({
    destination: (_,__,cb)=>cb(null, UPLOAD_DIR),
    filename: (_,file,cb)=>{
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, Date.now()+"-"+crypto.randomBytes(4).toString("hex")+ext);
    }
  }),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_,file,cb)=>{
    const ext = path.extname(file.originalname).toLowerCase();
    allowed.has(ext) ? cb(null,true) : cb(new Error("不支持该文件类型"));
  }
});

const css = `
:root{--bg:#f5f7fb;--text:#101828;--muted:#667085;--line:#e4e7ec;--p:#5b5ff0;--p2:#8b5cf6}
*{box-sizing:border-box}body{margin:0;font-family:Inter,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;color:var(--text);background:radial-gradient(circle at 15% 10%,rgba(91,95,240,.13),transparent 28%),radial-gradient(circle at 85% 15%,rgba(139,92,246,.12),transparent 25%),var(--bg)}
a{text-decoration:none;color:inherit}.wrap{width:min(1160px,calc(100% - 32px));margin:auto}.nav{height:72px;display:flex;align-items:center;justify-content:space-between}.brand{font-weight:800;display:flex;align-items:center;gap:10px}.logo{width:38px;height:38px;border-radius:12px;color:#fff;display:grid;place-items:center;background:linear-gradient(135deg,var(--p),var(--p2))}
.hero{text-align:center;padding:70px 0 36px}.hero h1{font-size:clamp(38px,6vw,66px);line-height:1.05;margin:15px 0}.hero p{color:var(--muted);font-size:16px;line-height:1.8}.tag{display:inline-block;background:#fff;border:1px solid var(--line);border-radius:999px;padding:8px 12px;color:#475467;font-size:13px}
.tools{max-width:800px;margin:28px auto 0;display:grid;grid-template-columns:1fr 180px;gap:10px}input,textarea,select{width:100%;border:1px solid #d0d5dd;border-radius:12px;padding:12px 13px;background:#fff;font:inherit;outline:none}textarea{min-height:90px;resize:vertical}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;padding:20px 0 60px}.card{background:rgba(255,255,255,.92);border:1px solid var(--line);border-radius:20px;padding:20px;box-shadow:0 18px 55px rgba(16,24,40,.07);display:flex;flex-direction:column;min-height:250px}.file{width:50px;height:50px;border-radius:15px;display:grid;place-items:center;background:rgba(91,95,240,.1);color:var(--p);font-weight:800}.badge{font-size:12px;color:#475467;background:#f2f4f7;padding:5px 9px;border-radius:999px}.row{display:flex;justify-content:space-between;align-items:center}.card h3{font-size:18px;margin:17px 0 8px}.desc{font-size:14px;line-height:1.7;color:var(--muted)}.meta{font-size:12px;color:#98a2b3;margin-top:auto;padding-top:15px}.btn{display:inline-flex;justify-content:center;align-items:center;border:0;border-radius:12px;padding:11px 14px;background:linear-gradient(135deg,var(--p),var(--p2));color:#fff;font-weight:700;cursor:pointer}.card .btn{margin-top:13px}.empty{grid-column:1/-1;padding:50px;text-align:center;color:var(--muted);background:#fff;border:1px dashed #d0d5dd;border-radius:18px}
.admin{width:min(1000px,calc(100% - 32px));margin:40px auto}.panel{background:#fff;border:1px solid var(--line);border-radius:20px;padding:22px;margin-bottom:18px;box-shadow:0 16px 50px rgba(16,24,40,.06)}.login{max-width:450px;margin:12vh auto}.form{display:grid;grid-template-columns:1fr 1fr;gap:14px}.full{grid-column:1/-1}.notice{font-size:13px;color:var(--muted)}.err{font-size:13px;color:#d92d20;margin-top:9px}.ok{font-size:13px;color:#027a48;margin-top:9px}.hidden{display:none!important}.item{display:grid;grid-template-columns:1fr auto;gap:15px;align-items:center;padding:14px;border:1px solid var(--line);border-radius:14px;margin-top:10px}.item h3{margin:0 0 5px;font-size:15px}.item p{margin:0;color:var(--muted);font-size:12px}.mini{border:1px solid var(--line);background:#fff;border-radius:9px;padding:7px 10px;cursor:pointer}.danger{color:#d92d20}.actions{display:flex;gap:7px}
@media(max-width:850px){.grid{grid-template-columns:repeat(2,1fr)}}@media(max-width:600px){.grid{grid-template-columns:1fr}.tools,.form{grid-template-columns:1fr}.full{grid-column:auto}.item{grid-template-columns:1fr}.hero{padding-top:45px}}
`;

const homeHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI漫剧资料中心</title><style>${css}</style></head><body>
<div class="wrap"><nav class="nav"><div class="brand"><span class="logo">AI</span>AI漫剧资料中心</div><a href="/admin.html" style="color:#667085;font-size:14px">管理员入口</a></nav>
<header class="hero"><span class="tag">✦ 课程资料 · 模板 · 配套资源</span><h1>把学习资料，集中在一个地方</h1><p>选择需要的文档，点击即可下载。支持 PDF、Word、PPT、Excel、压缩包等常用格式。</p><div class="tools"><input id="q" placeholder="搜索文档名称或关键词"><select id="cat"><option value="">全部分类</option></select></div></header>
<div class="row"><h2>资料下载</h2><span id="count" class="notice"></span></div><main class="grid" id="grid"></main></div>
<script>
let docs=[];const E=s=>String(s||"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));
function sz(b=0){return b<1024?b+" B":b<1048576?(b/1024).toFixed(1)+" KB":(b/1048576).toFixed(1)+" MB"}
function render(){const q=document.getElementById("q").value.toLowerCase().trim(),c=document.getElementById("cat").value;const arr=docs.filter(d=>(!q||((d.title+" "+d.description+" "+d.category).toLowerCase().includes(q)))&&(!c||d.category===c));document.getElementById("count").textContent="共 "+arr.length+" 份资料";document.getElementById("grid").innerHTML=arr.length?arr.map(d=>'<article class="card"><div class="row"><div class="file">'+E(d.type||"FILE")+'</div><span class="badge">'+E(d.category||"其他资料")+'</span></div><h3>'+E(d.title)+'</h3><div class="desc">'+E(d.description||"课程配套学习资料")+'</div><div class="meta">下载 '+Number(d.downloads||0)+' 次 · '+sz(d.size)+'</div><a class="btn" href="/download/'+encodeURIComponent(d.id)+'">立即下载</a></article>').join(""):'<div class="empty">暂时还没有资料</div>'}
fetch("/api/documents").then(r=>r.json()).then(x=>{docs=x;const cs=[...new Set(docs.map(d=>d.category).filter(Boolean))];document.getElementById("cat").innerHTML='<option value="">全部分类</option>'+cs.map(c=>'<option>'+E(c)+'</option>').join("");render()});document.getElementById("q").oninput=render;document.getElementById("cat").onchange=render;
</script></body></html>`;

const adminHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>后台管理</title><style>${css}</style></head><body><div class="admin">
<section id="login" class="panel login"><div class="brand"><span class="logo">AI</span>资料中心后台</div><h1>管理员登录</h1><p class="notice">登录后可以上传、编辑、隐藏或删除资料。</p><form id="lf"><input id="pw" type="password" placeholder="管理员密码" required><button class="btn" style="width:100%;margin-top:12px">登录后台</button><div id="lm"></div></form></section>
<div id="main" class="hidden"><div class="row" style="margin-bottom:18px"><div><h1 style="margin:0">资料管理</h1><p class="notice">上传后前台自动出现。</p></div><div class="actions"><a class="mini" href="/" target="_blank">查看前台</a><button id="lo" class="mini">退出</button></div></div>
<section class="panel"><h2>上传新资料</h2><form id="uf" class="form"><div><label>文档名称</label><input name="title" required></div><div><label>分类</label><input name="category" required></div><div class="full"><label>简介</label><textarea name="description"></textarea></div><div class="full"><label>选择文件</label><input name="file" type="file" required><p class="notice">支持 PDF、Word、PPT、Excel、ZIP/RAR/7Z、TXT，单文件最大 100MB。</p></div><div class="full"><button class="btn">上传并发布</button><span id="um"></span></div></form></section>
<section class="panel"><div class="row"><h2>已上传资料</h2><span id="ct" class="notice"></span></div><div id="list"></div></section></div></div>
<script>
const E=s=>String(s||"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));
async function auth(){const d=await fetch("/api/me").then(r=>r.json());document.getElementById("login").classList.toggle("hidden",d.isAdmin);document.getElementById("main").classList.toggle("hidden",!d.isAdmin);if(d.isAdmin)load()}
document.getElementById("lf").onsubmit=async e=>{e.preventDefault();const r=await fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:document.getElementById("pw").value})});const d=await r.json();if(r.ok){document.getElementById("lm").textContent="";auth()}else{document.getElementById("lm").className="err";document.getElementById("lm").textContent=d.error||"登录失败"}};
document.getElementById("lo").onclick=async()=>{await fetch("/api/logout",{method:"POST"});auth()};
document.getElementById("uf").onsubmit=async e=>{e.preventDefault();const m=document.getElementById("um");m.className="notice";m.textContent=" 正在上传...";const r=await fetch("/api/admin/documents",{method:"POST",body:new FormData(e.target)});const d=await r.json().catch(()=>({}));if(r.ok){m.className="ok";m.textContent=" 上传成功";e.target.reset();load()}else{m.className="err";m.textContent=" "+(d.error||"上传失败")}};
async function load(){const r=await fetch("/api/admin/documents");if(r.status===401)return auth();const ds=await r.json();document.getElementById("ct").textContent="共 "+ds.length+" 份";document.getElementById("list").innerHTML=ds.length?ds.map(d=>'<div class="item"><div><h3>'+E(d.title)+(d.visible===false?' <span class="badge">已隐藏</span>':'')+'</h3><p>'+E(d.category)+' · 下载 '+Number(d.downloads||0)+' 次</p></div><div class="actions"><button class="mini" onclick="editD(\\''+d.id+'\\')">编辑</button><button class="mini" onclick="visD(\\''+d.id+'\\','+(d.visible!==false)+')">'+(d.visible===false?'显示':'隐藏')+'</button><button class="mini danger" onclick="delD(\\''+d.id+'\\')">删除</button></div></div>').join(""):'<p class="notice">还没有上传资料。</p>'}
window.editD=async id=>{const ds=await fetch("/api/admin/documents").then(r=>r.json()),d=ds.find(x=>x.id===id);if(!d)return;const title=prompt("文档名称",d.title);if(title===null)return;const category=prompt("分类",d.category);if(category===null)return;const description=prompt("简介",d.description||"");if(description===null)return;await fetch("/api/admin/documents/"+id,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({title,category,description})});load()};
window.visD=async(id,v)=>{await fetch("/api/admin/documents/"+id,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({visible:!v})});load()};
window.delD=async id=>{if(!confirm("确定删除这份资料吗？"))return;await fetch("/api/admin/documents/"+id,{method:"DELETE"});load()};
auth();
</script></body></html>`;

app.get("/", (_,res)=>res.type("html").send(homeHtml));
app.get("/admin.html", (_,res)=>res.type("html").send(adminHtml));

app.post("/api/login",(req,res)=>{
  if(String(req.body.password||"")===ADMIN_PASSWORD){
    req.session.isAdmin=true; return res.json({ok:true});
  }
  res.status(401).json({error:"密码错误"});
});
app.post("/api/logout",(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get("/api/me",(req,res)=>res.json({isAdmin:Boolean(req.session?.isAdmin)}));

app.get("/api/documents",(req,res)=>{
  const docs=readDocs().filter(d=>d.visible!==false).sort((a,b)=>(b.createdAt||"").localeCompare(a.createdAt||""));
  res.json(docs);
});
app.get("/api/admin/documents",adminOnly,(req,res)=>res.json(readDocs().sort((a,b)=>(b.createdAt||"").localeCompare(a.createdAt||""))));

app.post("/api/admin/documents",adminOnly,upload.single("file"),(req,res)=>{
  if(!req.file) return res.status(400).json({error:"请选择文档"});
  const docs=readDocs();
  const ext=path.extname(req.file.originalname).replace(".","").toUpperCase();
  const doc={
    id:crypto.randomUUID(),
    title:clean(req.body.title,100)||req.file.originalname,
    category:clean(req.body.category,50)||"其他资料",
    description:clean(req.body.description,300),
    originalName:req.file.originalname,
    storedName:req.file.filename,
    type:ext||"FILE",
    size:req.file.size,
    downloads:0,
    visible:true,
    createdAt:new Date().toISOString()
  };
  docs.push(doc); writeDocs(docs); res.json({ok:true,document:doc});
});

app.patch("/api/admin/documents/:id",adminOnly,(req,res)=>{
  const docs=readDocs(),d=docs.find(x=>x.id===req.params.id);
  if(!d) return res.status(404).json({error:"文档不存在"});
  if("title" in req.body)d.title=clean(req.body.title,100);
  if("category" in req.body)d.category=clean(req.body.category,50)||"其他资料";
  if("description" in req.body)d.description=clean(req.body.description,300);
  if("visible" in req.body)d.visible=Boolean(req.body.visible);
  writeDocs(docs); res.json({ok:true});
});

app.delete("/api/admin/documents/:id",adminOnly,(req,res)=>{
  const docs=readDocs(),i=docs.findIndex(x=>x.id===req.params.id);
  if(i<0)return res.status(404).json({error:"文档不存在"});
  const [d]=docs.splice(i,1),f=path.join(UPLOAD_DIR,d.storedName);
  try{if(fs.existsSync(f))fs.unlinkSync(f)}catch{}
  writeDocs(docs); res.json({ok:true});
});

app.get("/download/:id",(req,res)=>{
  const docs=readDocs(),d=docs.find(x=>x.id===req.params.id&&x.visible!==false);
  if(!d)return res.status(404).send("文件不存在");
  const f=path.join(UPLOAD_DIR,d.storedName);
  if(!fs.existsSync(f))return res.status(404).send("文件已丢失");
  d.downloads=Number(d.downloads||0)+1; writeDocs(docs);
  res.download(f,d.originalName);
});

app.use((err,req,res,next)=>{
  if(err?.code==="LIMIT_FILE_SIZE")return res.status(400).json({error:"单个文件不能超过100MB"});
  res.status(400).json({error:err?.message||"操作失败"});
});

app.listen(PORT,()=>console.log("网站已启动，端口："+PORT));
