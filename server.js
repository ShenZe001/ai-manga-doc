const express = require("express");
const session = require("express-session");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
app.set("trust proxy", 1);

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change-me";
const SESSION_SECRET = process.env.SESSION_SECRET || "change-this-secret";
const STORAGE_ROOT = process.env.STORAGE_DIR || path.join(__dirname, "storage");
const DATA_FILE = path.join(STORAGE_ROOT, "documents.json");
const SETTINGS_FILE = path.join(STORAGE_ROOT, "site-settings.json");
const UPLOAD_DIR = path.join(STORAGE_ROOT, "uploads");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, "[]", "utf8");

const DEFAULT_SETTINGS = {
  announcement: {
    enabled: true,
    title: "置顶公告",
    content: "欢迎使用人民邮电出版社工具包。"
  },
  submission: {
    enabled: true,
    title: "投稿邮箱",
    email: "",
    content: "投稿前请确认作品及资料完整，并按照要求发送至指定邮箱。"
  }
};

if (!fs.existsSync(SETTINGS_FILE)) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(DEFAULT_SETTINGS, null, 2), "utf8");
}

app.use(express.json({ limit: "1mb" }));
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
function readSettings() {
  try {
    const current = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    return {
      announcement: { ...DEFAULT_SETTINGS.announcement, ...(current.announcement || {}) },
      submission: { ...DEFAULT_SETTINGS.submission, ...(current.submission || {}) }
    };
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  }
}
function writeSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf8");
}
function clean(v, max=500) {
  return String(v || "").trim().slice(0, max);
}
function adminOnly(req, res, next) {
  if (req.session?.isAdmin) return next();
  res.status(401).json({ error: "未登录或登录已过期" });
}

function validHttpUrl(value) {
  try {
    const u = new URL(String(value || "").trim());
    return (u.protocol === "http:" || u.protocol === "https:") ? u.toString() : null;
  } catch {
    return null;
  }
}

const allowed = new Set([
  ".pdf",".doc",".docx",".ppt",".pptx",
  ".xls",".xlsx",".zip",".rar",".7z",".txt"
]);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_, __, cb) => cb(null, UPLOAD_DIR),
    filename: (_, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, Date.now() + "-" + crypto.randomBytes(4).toString("hex") + ext);
    }
  }),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    allowed.has(ext) ? cb(null, true) : cb(new Error("不支持该文件类型"));
  }
});

const css = `
:root{
  --bg:#f5f7fb;--text:#101828;--muted:#667085;--line:#e4e7ec;
  --p:#5b5ff0;--p2:#8b5cf6;--danger:#d92d20;--ok:#027a48
}
*{box-sizing:border-box}
body{
  margin:0;font-family:Inter,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;
  color:var(--text);
  background:
    radial-gradient(circle at 15% 10%,rgba(91,95,240,.13),transparent 28%),
    radial-gradient(circle at 85% 15%,rgba(139,92,246,.12),transparent 25%),
    var(--bg)
}
a{text-decoration:none;color:inherit}
button,input,textarea,select{font:inherit}
button{cursor:pointer}
.wrap{width:min(1160px,calc(100% - 32px));margin:auto}
.nav{height:72px;display:flex;align-items:center;justify-content:space-between}
.brand{font-weight:800;display:flex;align-items:center;gap:10px}
.logo{
  width:38px;height:38px;border-radius:12px;color:#fff;display:grid;place-items:center;
  background:linear-gradient(135deg,var(--p),var(--p2))
}
.hero{text-align:center;padding:70px 0 36px}
.hero h1{font-size:clamp(38px,6vw,66px);line-height:1.05;margin:15px 0}
.hero p{color:var(--muted);font-size:16px;line-height:1.8}
.tag{
  display:inline-block;background:#fff;border:1px solid var(--line);
  border-radius:999px;padding:8px 12px;color:#475467;font-size:13px
}
.tools{max-width:800px;margin:28px auto 0;display:grid;grid-template-columns:1fr 180px;gap:10px}
input,textarea,select{
  width:100%;border:1px solid #d0d5dd;border-radius:12px;padding:12px 13px;
  background:#fff;outline:none
}
textarea{min-height:110px;resize:vertical}
input:focus,textarea:focus,select:focus{
  border-color:#9b9ef8;box-shadow:0 0 0 4px rgba(91,95,240,.08)
}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;padding:20px 0 60px}
.card{
  background:rgba(255,255,255,.92);border:1px solid var(--line);border-radius:20px;
  padding:20px;box-shadow:0 18px 55px rgba(16,24,40,.07);
  display:flex;flex-direction:column;min-height:250px
}
.file{
  width:50px;height:50px;border-radius:15px;display:grid;place-items:center;
  background:rgba(91,95,240,.1);color:var(--p);font-weight:800
}
.badge{font-size:12px;color:#475467;background:#f2f4f7;padding:5px 9px;border-radius:999px}
.row{display:flex;justify-content:space-between;align-items:center;gap:12px}
.card h3{font-size:18px;margin:17px 0 8px}
.desc{font-size:14px;line-height:1.7;color:var(--muted)}
.meta{font-size:12px;color:#98a2b3;margin-top:auto;padding-top:15px}
.btn{
  display:inline-flex;justify-content:center;align-items:center;border:0;border-radius:12px;
  padding:11px 14px;background:linear-gradient(135deg,var(--p),var(--p2));
  color:#fff;font-weight:700
}
.card .btn{margin-top:13px}
.empty{
  grid-column:1/-1;padding:50px;text-align:center;color:var(--muted);
  background:#fff;border:1px dashed #d0d5dd;border-radius:18px
}
.notice-board{
  margin:12px 0 18px;padding:18px 20px;border-radius:18px;
  background:linear-gradient(135deg,rgba(255,248,225,.98),rgba(255,252,242,.98));
  border:1px solid #f4d98a;box-shadow:0 14px 42px rgba(146,105,16,.08)
}
.notice-board .notice-title{
  display:flex;align-items:center;gap:8px;margin:0 0 8px;
  font-size:16px;font-weight:800;color:#7a5310
}
.notice-board .notice-content{
  color:#6b5a35;line-height:1.75;font-size:14px;white-space:pre-wrap
}
.submission-box{
  margin:0 0 22px;padding:20px;border-radius:18px;background:#fff;
  border:1px solid var(--line);box-shadow:0 14px 42px rgba(16,24,40,.06);
  display:grid;grid-template-columns:1fr auto;gap:18px;align-items:center
}
.submission-box h3{margin:0 0 7px;font-size:17px}
.submission-box p{margin:0;color:var(--muted);font-size:14px;line-height:1.7;white-space:pre-wrap}
.email-link{
  display:inline-flex;align-items:center;justify-content:center;min-width:190px;
  padding:11px 15px;border-radius:12px;border:1px solid #c7c9ff;
  background:#f7f7ff;color:#4548ce;font-weight:700;word-break:break-all
}
.settings-grid{
  display:grid;grid-template-columns:1fr 1fr;gap:18px
}
.settings-card{
  border:1px solid var(--line);border-radius:16px;padding:18px;background:#fbfcfe
}
.switch-row{
  display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px
}
.switch-row input[type="checkbox"]{width:18px;height:18px}


/* admin */
.admin{width:min(1050px,calc(100% - 32px));margin:40px auto}
.panel{
  background:#fff;border:1px solid var(--line);border-radius:20px;padding:22px;
  margin-bottom:18px;box-shadow:0 16px 50px rgba(16,24,40,.06)
}
.login{max-width:450px;margin:12vh auto}
.form{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.full{grid-column:1/-1}
label{display:block;font-size:13px;color:#475467;margin-bottom:7px}
.notice{font-size:13px;color:var(--muted)}
.err{font-size:13px;color:var(--danger);margin-top:9px}
.ok{font-size:13px;color:var(--ok);margin-top:9px}
.hidden{display:none!important}
.item{
  display:grid;grid-template-columns:1fr auto;gap:18px;align-items:center;
  padding:16px;border:1px solid var(--line);border-radius:14px;margin-top:10px
}
.item h3{margin:0 0 6px;font-size:16px}
.item .admin-desc{
  margin:6px 0 0;color:var(--muted);font-size:13px;line-height:1.65;
  max-width:690px;white-space:pre-wrap
}
.item p{margin:0;color:#98a2b3;font-size:12px}
.mini{
  border:1px solid var(--line);background:#fff;border-radius:9px;
  padding:8px 11px;cursor:pointer
}
.mini.primary{color:var(--p);border-color:#c7c9ff;background:#f7f7ff}
.danger{color:var(--danger)}
.actions{display:flex;gap:7px;flex-wrap:wrap;justify-content:flex-end}

/* edit modal */
.modal-mask{
  position:fixed;inset:0;background:rgba(16,24,40,.52);backdrop-filter:blur(5px);
  display:grid;place-items:center;padding:20px;z-index:999
}
.modal{
  width:min(680px,100%);background:#fff;border-radius:22px;padding:24px;
  box-shadow:0 30px 90px rgba(16,24,40,.25)
}
.modal-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}
.modal-head h2{margin:0;font-size:22px}
.close-btn{
  width:36px;height:36px;border:1px solid var(--line);background:#fff;
  border-radius:10px;font-size:20px;line-height:1
}
.modal-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:18px}
.secondary{
  border:1px solid var(--line);background:#fff;color:#344054;
  border-radius:12px;padding:11px 16px
}
.file-lock{
  padding:12px 14px;border-radius:12px;background:#f8f9fc;
  border:1px solid var(--line);font-size:13px;color:#667085
}

@media(max-width:850px){.grid{grid-template-columns:repeat(2,1fr)}}
@media(max-width:600px){
  .grid{grid-template-columns:1fr}
  .tools,.form,.settings-grid{grid-template-columns:1fr}
  .submission-box{grid-template-columns:1fr}
  .email-link{width:100%}
  .full{grid-column:auto}
  .item{grid-template-columns:1fr}
  .actions{justify-content:flex-start}
  .hero{padding-top:45px}
}
`;

const homeHtml = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>人民邮电出版社工具包</title>
<style>${css}</style>
</head>
<body>
<div class="wrap">
  <nav class="nav">
    <div class="brand"><span class="logo">AI</span>人民邮电出版社工具包</div>
    <a href="/admin.html" style="color:#667085;font-size:14px">管理员入口</a>
  </nav>

  <header class="hero">
    <span class="tag">✦ 课程资料 · 模板 · 配套资源</span>
    <h1>把学习资料，集中在一个地方</h1>
    <p>文件可以直接下载，工具或资源网址可以一键直达。支持 PDF、Word、PPT、Excel、压缩包及外部链接。</p>
    <div class="tools">
      <input id="q" placeholder="搜索文档名称或关键词">
      <select id="cat"><option value="">全部分类</option></select>
    </div>
  </header>

  <section id="announcementBox" class="notice-board hidden">
    <div class="notice-title">📌 <span id="announcementTitle">置顶公告</span></div>
    <div id="announcementContent" class="notice-content"></div>
  </section>

  <section id="submissionBox" class="submission-box hidden">
    <div>
      <h3 id="submissionTitle">投稿邮箱</h3>
      <p id="submissionContent"></p>
    </div>
    <a id="submissionEmail" class="email-link" href="#"></a>
  </section>

  <div class="row">
    <h2>资料与工具</h2>
    <span id="count" class="notice"></span>
  </div>
  <main class="grid" id="grid"></main>
</div>

<script>
let docs=[];
const E=s=>String(s||"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));
function sz(b=0){return b<1024?b+" B":b<1048576?(b/1024).toFixed(1)+" KB":(b/1048576).toFixed(1)+" MB"}
function render(){
  const q=document.getElementById("q").value.toLowerCase().trim();
  const c=document.getElementById("cat").value;
  const arr=docs.filter(d=>
    (!q||((d.title+" "+d.description+" "+d.category).toLowerCase().includes(q))) &&
    (!c||d.category===c)
  );
  document.getElementById("count").textContent="共 "+arr.length+" 份资料";
  document.getElementById("grid").innerHTML=arr.length
    ? arr.map(d=>'<article class="card">'+
      '<div class="row"><div class="file">'+(d.kind==="link"?"LINK":E(d.type||"FILE"))+'</div><div style="display:flex;gap:6px;align-items:center">'+(d.pinned?'<span class="badge" style="background:#fff3cd;color:#8a6116">置顶</span>':'')+(d.kind==="link"?'<span class="badge" style="background:#eef4ff;color:#3538cd">直达链接</span>':'')+'<span class="badge">'+E(d.category||"其他资料")+'</span></div></div>'+
      '<h3>'+E(d.title)+'</h3>'+
      '<div class="desc">'+E(d.description||"课程配套学习资料")+'</div>'+
      '<div class="meta">'+(d.kind==="link"?"访问 ":"下载 ")+Number(d.downloads||0)+' 次'+(d.kind==="link"?" · 外部链接":" · "+sz(d.size))+'</div>'+
      (d.kind==="link"
        ? '<a class="btn" target="_blank" rel="noopener noreferrer" href="/go/'+encodeURIComponent(d.id)+'">立即前往</a>'
        : '<a class="btn" href="/download/'+encodeURIComponent(d.id)+'">立即下载</a>')+
      '</article>').join("")
    : '<div class="empty">暂时还没有资料</div>';
}

fetch("/api/site-settings").then(r=>r.json()).then(s=>{
  const a=s.announcement||{};
  const ab=document.getElementById("announcementBox");
  if(a.enabled && (a.title||a.content)){
    document.getElementById("announcementTitle").textContent=a.title||"置顶公告";
    document.getElementById("announcementContent").textContent=a.content||"";
    ab.classList.remove("hidden");
  }

  const sub=s.submission||{};
  const sb=document.getElementById("submissionBox");
  if(sub.enabled && (sub.email||sub.content)){
    document.getElementById("submissionTitle").textContent=sub.title||"投稿邮箱";
    document.getElementById("submissionContent").textContent=sub.content||"";
    const email=document.getElementById("submissionEmail");
    if(sub.email){
      email.textContent=sub.email;
      email.href="mailto:"+encodeURIComponent(sub.email);
      email.style.display="inline-flex";
    }else{
      email.textContent="邮箱暂未设置";
      email.removeAttribute("href");
    }
    sb.classList.remove("hidden");
  }
}).catch(()=>{});

fetch("/api/documents").then(r=>r.json()).then(x=>{
  docs=x;
  const cs=[...new Set(docs.map(d=>d.category).filter(Boolean))];
  document.getElementById("cat").innerHTML='<option value="">全部分类</option>'+
    cs.map(c=>'<option>'+E(c)+'</option>').join("");
  render();
});
document.getElementById("q").oninput=render;
document.getElementById("cat").onchange=render;
</script>
</body>
</html>`;

const adminHtml = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>人民邮电出版社工具包｜资料管理后台</title>
<style>${css}</style>
</head>
<body>

<div class="admin">
  <section id="login" class="panel login">
    <div class="brand"><span class="logo">AI</span>人民邮电出版社工具包后台</div>
    <h1>管理员登录</h1>
    <p class="notice">登录后可以上传、编辑、隐藏或删除资料。</p>
    <form id="lf">
      <input id="pw" type="password" placeholder="管理员密码" required>
      <button class="btn" style="width:100%;margin-top:12px">登录后台</button>
      <div id="lm"></div>
    </form>
  </section>

  <div id="main" class="hidden">
    <div class="row" style="margin-bottom:18px">
      <div>
        <h1 style="margin:0">资料管理</h1>
        <p class="notice">文件和直达链接发布后都会自动出现在前台；名称、分类、简介和链接地址都可以随时修改。</p>
      </div>
      <div class="actions">
        <a class="mini" href="/" target="_blank">查看前台</a>
        <button id="lo" class="mini">退出</button>
      </div>
    </div>

    <section class="panel">
      <div class="row" style="align-items:flex-start">
        <div>
          <h2 style="margin:0 0 5px">页面信息设置</h2>
          <div class="notice">这里可以随时修改前台的置顶公告和投稿邮箱，不需要改代码。</div>
        </div>
      </div>

      <div class="settings-grid" style="margin-top:18px">
        <form id="announcementForm" class="settings-card">
          <div class="switch-row">
            <strong>置顶公告</strong>
            <label style="margin:0;display:flex;align-items:center;gap:7px">
              <input id="announcementEnabled" type="checkbox">
              <span>前台显示</span>
            </label>
          </div>

          <div style="margin-bottom:12px">
            <label>公告标题</label>
            <input id="announcementTitleInput" placeholder="例如：重要通知">
          </div>

          <div style="margin-bottom:12px">
            <label>公告内容</label>
            <textarea id="announcementContentInput" placeholder="填写需要长期置顶展示的公告内容"></textarea>
          </div>

          <button class="btn" type="submit">保存公告</button>
          <span id="announcementMsg"></span>
        </form>

        <form id="submissionForm" class="settings-card">
          <div class="switch-row">
            <strong>投稿邮箱</strong>
            <label style="margin:0;display:flex;align-items:center;gap:7px">
              <input id="submissionEnabled" type="checkbox">
              <span>前台显示</span>
            </label>
          </div>

          <div style="margin-bottom:12px">
            <label>板块标题</label>
            <input id="submissionTitleInput" placeholder="投稿邮箱">
          </div>

          <div style="margin-bottom:12px">
            <label>投稿邮箱地址</label>
            <input id="submissionEmailInput" type="email" placeholder="example@email.com">
          </div>

          <div style="margin-bottom:12px">
            <label>投稿说明</label>
            <textarea id="submissionContentInput" placeholder="例如：投稿请注明作品名称、作者姓名及联系方式。"></textarea>
          </div>

          <button class="btn" type="submit">保存投稿信息</button>
          <span id="submissionMsg"></span>
        </form>
      </div>
    </section>

    <section class="panel">
      <h2>上传新资料</h2>
      <form id="uf" class="form">
        <div>
          <label>文档名称</label>
          <input name="title" required>
        </div>
        <div>
          <label>分类</label>
          <input name="category" required>
        </div>
        <div class="full">
          <label>简介</label>
          <textarea name="description" placeholder="填写这份资料的介绍"></textarea>
        </div>
        <div class="full">
          <label>选择文件</label>
          <input name="file" type="file" required>
          <p class="notice">支持 PDF、Word、PPT、Excel、ZIP/RAR/7Z、TXT，单文件最大 100MB。</p>
        </div>
        <div class="full">
          <button class="btn">上传并发布</button>
          <span id="um"></span>
        </div>
      </form>
    </section>

    <section class="panel">
      <div class="row" style="align-items:flex-start">
        <div>
          <h2 style="margin:0 0 5px">添加直达链接</h2>
          <div class="notice">适合放生视频、生图、工具平台、教程页等网址。访客点击后直接跳转。</div>
        </div>
        <span class="badge" style="background:#eef4ff;color:#3538cd">LINK</span>
      </div>

      <form id="linkForm" class="form" style="margin-top:18px">
        <div>
          <label>链接名称</label>
          <input name="title" placeholder="例如：AI生视频工具" required>
        </div>
        <div>
          <label>分类</label>
          <input name="category" placeholder="例如：生视频工具" required>
        </div>
        <div class="full">
          <label>简介</label>
          <textarea name="description" placeholder="例如：点击进入在线AI视频生成平台"></textarea>
        </div>
        <div class="full">
          <label>直达网址</label>
          <input name="url" type="url" placeholder="https://..." required>
          <p class="notice">请填写完整网址，必须以 http:// 或 https:// 开头。</p>
        </div>
        <div class="full">
          <button class="btn" type="submit">发布直达链接</button>
          <span id="linkMsg"></span>
        </div>
      </form>
    </section>

    <section class="panel">
      <div class="row">
        <div>
          <h2 style="margin-bottom:4px">已上传资料</h2>
          <div class="notice">点击“编辑资料”即可修改简介，不会重新上传文件。</div>
        </div>
        <span id="ct" class="notice"></span>
      </div>
      <div id="list"></div>
    </section>
  </div>
</div>

<div id="editMask" class="modal-mask hidden">
  <div class="modal">
    <div class="modal-head">
      <h2>编辑资料</h2>
      <button id="editClose" class="close-btn" type="button">×</button>
    </div>

    <form id="editForm">
      <input type="hidden" id="editId">

      <div style="margin-bottom:14px">
        <label>文档名称</label>
        <input id="editTitle" required>
      </div>

      <div style="margin-bottom:14px">
        <label>分类</label>
        <input id="editCategory" required>
      </div>

      <div style="margin-bottom:14px">
        <label>简介</label>
        <textarea id="editDescription" placeholder="修改这份资料的简介"></textarea>
      </div>

      <div id="editFileBlock" style="margin-bottom:14px">
        <label>当前文件</label>
        <div id="editFileName" class="file-lock"></div>
        <div class="notice" style="margin-top:7px">这里只修改资料信息，原文件保持不变，不需要重新上传。</div>
      </div>

      <div id="editLinkBlock" class="hidden" style="margin-bottom:14px">
        <label>直达网址</label>
        <input id="editUrl" type="url" placeholder="https://...">
        <div class="notice" style="margin-top:7px">可以直接修改网址，不需要重新发布这条资料。</div>
      </div>

      <div id="editMsg"></div>

      <div class="modal-actions">
        <button id="editCancel" class="secondary" type="button">取消</button>
        <button class="btn" type="submit">保存修改</button>
      </div>
    </form>
  </div>
</div>

<script>
const E=s=>String(s||"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));
let adminDocs=[];

async function auth(){
  const d=await fetch("/api/me").then(r=>r.json());
  document.getElementById("login").classList.toggle("hidden",d.isAdmin);
  document.getElementById("main").classList.toggle("hidden",!d.isAdmin);
  if(d.isAdmin){
    load();
    loadSiteSettings();
  }
}

document.getElementById("lf").onsubmit=async e=>{
  e.preventDefault();
  const m=document.getElementById("lm");
  m.className="notice";
  m.textContent="正在登录...";
  try{
    const r=await fetch("/api/login",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({password:document.getElementById("pw").value})
    });
    const d=await r.json();
    if(r.ok){
      m.className="ok";
      m.textContent="登录成功";
      await auth();
    }else{
      m.className="err";
      m.textContent=d.error||"登录失败";
    }
  }catch{
    m.className="err";
    m.textContent="登录请求失败，请刷新页面后重试";
  }
};

document.getElementById("lo").onclick=async()=>{
  await fetch("/api/logout",{method:"POST"});
  auth();
};

document.getElementById("uf").onsubmit=async e=>{
  e.preventDefault();
  const m=document.getElementById("um");
  m.className="notice";
  m.textContent=" 正在上传...";
  try{
    const r=await fetch("/api/admin/documents",{method:"POST",body:new FormData(e.target)});
    const d=await r.json().catch(()=>({}));
    if(r.ok){
      m.className="ok";
      m.textContent=" 上传成功";
      e.target.reset();
      load();
    }else{
      m.className="err";
      m.textContent=" "+(d.error||"上传失败");
    }
  }catch{
    m.className="err";
    m.textContent=" 上传请求失败";
  }
};



async function loadSiteSettings(){
  try{
    const r=await fetch("/api/admin/site-settings");
    if(r.status===401) return auth();
    const s=await r.json();

    const a=s.announcement||{};
    document.getElementById("announcementEnabled").checked=Boolean(a.enabled);
    document.getElementById("announcementTitleInput").value=a.title||"置顶公告";
    document.getElementById("announcementContentInput").value=a.content||"";

    const sub=s.submission||{};
    document.getElementById("submissionEnabled").checked=Boolean(sub.enabled);
    document.getElementById("submissionTitleInput").value=sub.title||"投稿邮箱";
    document.getElementById("submissionEmailInput").value=sub.email||"";
    document.getElementById("submissionContentInput").value=sub.content||"";
  }catch{}
}

document.getElementById("announcementForm").onsubmit=async e=>{
  e.preventDefault();
  const m=document.getElementById("announcementMsg");
  m.className="notice";
  m.textContent=" 正在保存...";

  try{
    const r=await fetch("/api/admin/site-settings",{
      method:"PATCH",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        announcement:{
          enabled:document.getElementById("announcementEnabled").checked,
          title:document.getElementById("announcementTitleInput").value,
          content:document.getElementById("announcementContentInput").value
        }
      })
    });
    const d=await r.json().catch(()=>({}));
    if(r.ok){
      m.className="ok";
      m.textContent=" 保存成功";
    }else{
      m.className="err";
      m.textContent=" "+(d.error||"保存失败");
    }
  }catch{
    m.className="err";
    m.textContent=" 保存请求失败";
  }
};

document.getElementById("submissionForm").onsubmit=async e=>{
  e.preventDefault();
  const m=document.getElementById("submissionMsg");
  m.className="notice";
  m.textContent=" 正在保存...";

  try{
    const r=await fetch("/api/admin/site-settings",{
      method:"PATCH",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        submission:{
          enabled:document.getElementById("submissionEnabled").checked,
          title:document.getElementById("submissionTitleInput").value,
          email:document.getElementById("submissionEmailInput").value,
          content:document.getElementById("submissionContentInput").value
        }
      })
    });
    const d=await r.json().catch(()=>({}));
    if(r.ok){
      m.className="ok";
      m.textContent=" 保存成功";
    }else{
      m.className="err";
      m.textContent=" "+(d.error||"保存失败");
    }
  }catch{
    m.className="err";
    m.textContent=" 保存请求失败";
  }
};

document.getElementById("linkForm").onsubmit=async e=>{
  e.preventDefault();
  const m=document.getElementById("linkMsg");
  m.className="notice";
  m.textContent=" 正在发布...";

  const form=new FormData(e.target);
  const payload={
    title:form.get("title"),
    category:form.get("category"),
    description:form.get("description"),
    url:form.get("url")
  };

  try{
    const r=await fetch("/api/admin/links",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify(payload)
    });
    const d=await r.json().catch(()=>({}));

    if(r.ok){
      m.className="ok";
      m.textContent=" 发布成功";
      e.target.reset();
      load();
    }else{
      m.className="err";
      m.textContent=" "+(d.error||"发布失败");
    }
  }catch{
    m.className="err";
    m.textContent=" 发布请求失败";
  }
};

async function load(){
  const r=await fetch("/api/admin/documents");
  if(r.status===401) return auth();
  adminDocs=await r.json();
  document.getElementById("ct").textContent="共 "+adminDocs.length+" 份";

  document.getElementById("list").innerHTML=adminDocs.length
    ? adminDocs.map(d=>
      '<div class="item">'+
        '<div>'+
          '<h3>'+E(d.title)+(d.pinned?' <span class="badge" style="background:#fff3cd;color:#8a6116">已置顶</span>':'')+(d.visible===false?' <span class="badge">已隐藏</span>':'')+'</h3>'+
          '<p>'+E(d.category)+' · '+(d.kind==="link"?"直达链接":E(d.type||"FILE"))+' · '+(d.kind==="link"?"访问 ":"下载 ")+Number(d.downloads||0)+' 次</p>'+
          '<div class="admin-desc">'+E(d.description||"暂无简介")+'</div>'+
        '</div>'+
        '<div class="actions">'+
          '<button class="mini" onclick="pinD(\\''+d.id+'\\','+Boolean(d.pinned)+')">'+(d.pinned?'取消置顶':'置顶')+'</button>'+
          '<button class="mini primary" onclick="openEdit(\\''+d.id+'\\')">编辑资料</button>'+
          '<button class="mini" onclick="visD(\\''+d.id+'\\','+(d.visible!==false)+')">'+(d.visible===false?'显示':'隐藏')+'</button>'+
          '<button class="mini danger" onclick="delD(\\''+d.id+'\\')">删除</button>'+
        '</div>'+
      '</div>'
    ).join("")
    : '<p class="notice">还没有上传资料。</p>';
}

window.openEdit=id=>{
  const d=adminDocs.find(x=>x.id===id);
  if(!d) return;

  document.getElementById("editId").value=d.id;
  document.getElementById("editTitle").value=d.title||"";
  document.getElementById("editCategory").value=d.category||"";
  document.getElementById("editDescription").value=d.description||"";

  const isLink=d.kind==="link";
  document.getElementById("editFileBlock").classList.toggle("hidden",isLink);
  document.getElementById("editLinkBlock").classList.toggle("hidden",!isLink);
  document.getElementById("editFileName").textContent=d.originalName||"原文件";
  document.getElementById("editUrl").value=isLink?(d.url||""):"";

  document.getElementById("editMsg").textContent="";
  document.getElementById("editMask").classList.remove("hidden");
};

function closeEdit(){
  document.getElementById("editMask").classList.add("hidden");
}
document.getElementById("editClose").onclick=closeEdit;
document.getElementById("editCancel").onclick=closeEdit;
document.getElementById("editMask").addEventListener("click",e=>{
  if(e.target.id==="editMask") closeEdit();
});

document.getElementById("editForm").onsubmit=async e=>{
  e.preventDefault();

  const id=document.getElementById("editId").value;
  const msg=document.getElementById("editMsg");
  msg.className="notice";
  msg.textContent="正在保存...";

  try{
    const r=await fetch("/api/admin/documents/"+encodeURIComponent(id),{
      method:"PATCH",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        title:document.getElementById("editTitle").value,
        category:document.getElementById("editCategory").value,
        description:document.getElementById("editDescription").value,
        url:document.getElementById("editLinkBlock").classList.contains("hidden")
          ? undefined
          : document.getElementById("editUrl").value
      })
    });

    const d=await r.json().catch(()=>({}));
    if(r.ok){
      msg.className="ok";
      msg.textContent="保存成功";
      await load();
      setTimeout(closeEdit,350);
    }else{
      msg.className="err";
      msg.textContent=d.error||"保存失败";
    }
  }catch{
    msg.className="err";
    msg.textContent="保存请求失败";
  }
};

window.pinD=async(id,pinned)=>{
  await fetch("/api/admin/documents/"+encodeURIComponent(id),{
    method:"PATCH",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({pinned:!pinned})
  });
  load();
};

window.visD=async(id,v)=>{
  await fetch("/api/admin/documents/"+encodeURIComponent(id),{
    method:"PATCH",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({visible:!v})
  });
  load();
};

window.delD=async id=>{
  if(!confirm("确定删除这份资料吗？删除后原文件也会一起删除。")) return;
  await fetch("/api/admin/documents/"+encodeURIComponent(id),{method:"DELETE"});
  load();
};

auth();
</script>
</body>
</html>`;

app.get("/", (_,res)=>res.type("html").send(homeHtml));
app.get("/admin.html", (_,res)=>res.type("html").send(adminHtml));

app.post("/api/login",(req,res)=>{
  if(String(req.body.password||"")===ADMIN_PASSWORD){
    req.session.isAdmin=true;
    return res.json({ok:true});
  }
  res.status(401).json({error:"密码错误"});
});

app.post("/api/logout",(req,res)=>{
  req.session.destroy(()=>res.json({ok:true}));
});

app.get("/api/me",(req,res)=>{
  res.json({isAdmin:Boolean(req.session?.isAdmin)});
});


app.get("/api/site-settings",(req,res)=>{
  const s=readSettings();
  res.json({
    announcement:s.announcement,
    submission:s.submission
  });
});

app.get("/api/admin/site-settings",adminOnly,(req,res)=>{
  res.json(readSettings());
});

app.patch("/api/admin/site-settings",adminOnly,(req,res)=>{
  const s=readSettings();

  if(req.body.announcement){
    const a=req.body.announcement;
    if("enabled" in a) s.announcement.enabled=Boolean(a.enabled);
    if("title" in a) s.announcement.title=clean(a.title,100)||"置顶公告";
    if("content" in a) s.announcement.content=clean(a.content,2000);
  }

  if(req.body.submission){
    const sub=req.body.submission;
    if("enabled" in sub) s.submission.enabled=Boolean(sub.enabled);
    if("title" in sub) s.submission.title=clean(sub.title,100)||"投稿邮箱";
    if("email" in sub) s.submission.email=clean(sub.email,200);
    if("content" in sub) s.submission.content=clean(sub.content,2000);
  }

  writeSettings(s);
  res.json({ok:true,settings:s});
});

app.get("/api/documents",(req,res)=>{
  const docs=readDocs()
    .filter(d=>d.visible!==false)
    .sort((a,b)=>{
      const pinDiff=Number(Boolean(b.pinned))-Number(Boolean(a.pinned));
      if(pinDiff!==0) return pinDiff;
      return (b.createdAt||"").localeCompare(a.createdAt||"");
    });
  res.json(docs);
});

app.get("/api/admin/documents",adminOnly,(req,res)=>{
  res.json(
    readDocs().sort((a,b)=>{
      const pinDiff=Number(Boolean(b.pinned))-Number(Boolean(a.pinned));
      if(pinDiff!==0) return pinDiff;
      return (b.createdAt||"").localeCompare(a.createdAt||"");
    })
  );
});

app.post("/api/admin/links",adminOnly,(req,res)=>{
  const title=clean(req.body.title,100);
  const category=clean(req.body.category,50)||"工具链接";
  const description=clean(req.body.description,500);
  const url=validHttpUrl(req.body.url);

  if(!title) return res.status(400).json({error:"链接名称不能为空"});
  if(!url) return res.status(400).json({error:"网址格式不正确，请填写以 http:// 或 https:// 开头的完整网址"});

  const docs=readDocs();
  const doc={
    id:crypto.randomUUID(),
    kind:"link",
    title,
    category,
    description,
    url,
    type:"LINK",
    size:0,
    downloads:0,
    visible:true,
    pinned:false,
    createdAt:new Date().toISOString()
  };

  docs.push(doc);
  writeDocs(docs);
  res.json({ok:true,document:doc});
});

app.post("/api/admin/documents",adminOnly,upload.single("file"),(req,res)=>{
  if(!req.file) return res.status(400).json({error:"请选择文档"});

  const docs=readDocs();
  const ext=path.extname(req.file.originalname).replace(".","").toUpperCase();

  const doc={
    id:crypto.randomUUID(),
    kind:"file",
    title:clean(req.body.title,100)||req.file.originalname,
    category:clean(req.body.category,50)||"其他资料",
    description:clean(req.body.description,500),
    originalName:req.file.originalname,
    storedName:req.file.filename,
    type:ext||"FILE",
    size:req.file.size,
    downloads:0,
    visible:true,
    pinned:false,
    createdAt:new Date().toISOString()
  };

  docs.push(doc);
  writeDocs(docs);
  res.json({ok:true,document:doc});
});

app.patch("/api/admin/documents/:id",adminOnly,(req,res)=>{
  const docs=readDocs();
  const d=docs.find(x=>x.id===req.params.id);

  if(!d) return res.status(404).json({error:"文档不存在"});

  if("title" in req.body) {
    const v=clean(req.body.title,100);
    if(!v) return res.status(400).json({error:"文档名称不能为空"});
    d.title=v;
  }

  if("category" in req.body) {
    d.category=clean(req.body.category,50)||"其他资料";
  }

  if("description" in req.body) {
    d.description=clean(req.body.description,500);
  }

  if("visible" in req.body) {
    d.visible=Boolean(req.body.visible);
  }

  if("pinned" in req.body) {
    d.pinned=Boolean(req.body.pinned);
  }

  if("url" in req.body && d.kind==="link") {
    const url=validHttpUrl(req.body.url);
    if(!url) return res.status(400).json({error:"网址格式不正确，请填写完整的 http:// 或 https:// 地址"});
    d.url=url;
  }

  d.updatedAt=new Date().toISOString();
  writeDocs(docs);

  res.json({ok:true,document:d});
});

app.delete("/api/admin/documents/:id",adminOnly,(req,res)=>{
  const docs=readDocs();
  const i=docs.findIndex(x=>x.id===req.params.id);

  if(i<0) return res.status(404).json({error:"文档不存在"});

  const [d]=docs.splice(i,1);

  if(d.kind!=="link" && d.storedName){
    const f=path.join(UPLOAD_DIR,d.storedName);
    try{
      if(fs.existsSync(f)) fs.unlinkSync(f);
    }catch{}
  }

  writeDocs(docs);
  res.json({ok:true});
});

app.get("/go/:id",(req,res)=>{
  const docs=readDocs();
  const d=docs.find(x=>x.id===req.params.id && x.visible!==false && x.kind==="link");

  if(!d) return res.status(404).send("链接不存在");

  const url=validHttpUrl(d.url);
  if(!url) return res.status(400).send("链接地址无效");

  d.downloads=Number(d.downloads||0)+1;
  writeDocs(docs);

  res.redirect(url);
});

app.get("/download/:id",(req,res)=>{
  const docs=readDocs();
  const d=docs.find(x=>x.id===req.params.id&&x.visible!==false&&x.kind!=="link");

  if(!d) return res.status(404).send("文件不存在");

  const f=path.join(UPLOAD_DIR,d.storedName);
  if(!fs.existsSync(f)) return res.status(404).send("文件已丢失");

  d.downloads=Number(d.downloads||0)+1;
  writeDocs(docs);

  res.download(f,d.originalName);
});

app.use((err,req,res,next)=>{
  console.error(err);
  if(err?.code==="LIMIT_FILE_SIZE"){
    return res.status(400).json({error:"单个文件不能超过100MB"});
  }
  res.status(400).json({error:err?.message||"操作失败"});
});

app.listen(PORT,()=>console.log("网站已启动，端口："+PORT));
