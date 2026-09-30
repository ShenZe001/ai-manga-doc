# 小北资料库｜稳定修复版

这是基于原 Railway / Express 项目重写整理的稳定版源码，保留原有后台、上传、资料管理、下载、在线预览和外部链接直达功能。

## 本次重点修复

- 修复“资料详情”弹窗默认就显示、页面被遮罩后无法继续点击的问题。
- 强制所有带 `hidden` 属性的区域真正隐藏，避免 CSS 把隐藏状态覆盖。
- 详情弹窗改为只有在资料内容成功写入后才打开。
- 资料 ID 统一按字符串比较，避免后台历史数据 ID 类型不同导致点开后内容空白。
- 增加关闭按钮、点击遮罩关闭、Esc 关闭、返回页面自动复位。
- 弹窗打开时锁定页面滚动，关闭后恢复。
- PDF / TXT / MD 在线预览仍保留；新增 MD / Markdown 上传与在线格式化预览；文件下载、工具直达链接仍保留。
- 手机端继续保留单列资料卡片、横向分类导航和自适应详情弹窗。

## 保留功能

- `/`：资料库前台
- `/admin.html`：站长后台
- 管理员登录
- 上传资料
- 新增外部直达链接
- 编辑标题、分类、简介、版本、排序
- 置顶、推荐、显示/隐藏、删除
- 公告与投稿邮箱设置
- 本地文件存储 / S3 兼容对象存储
- PDF / TXT / MD 在线预览
- 文件下载与访问次数统计

## 部署

```bash
npm install
npm start
```

默认端口为 `3000`，Railway 会自动使用环境变量中的 `PORT`。

生产环境建议至少设置：

- `ADMIN_PASSWORD`
- `SESSION_SECRET`

如果继续使用对象存储，再保留：

- `BUCKET`
- `ENDPOINT`
- `REGION`
- `ACCESS_KEY_ID`
- `SECRET_ACCESS_KEY`

如果 Railway 已经挂载持久化 Volume 到 `storage`，替换源码不会删除现有资料数据。

## GitHub 上传方式

压缩包已经做成“根目录版”。解压后，把 `package.json`、`package-lock.json`、`server.js`、`README.md` 直接放到 GitHub 仓库根目录即可。这样 Railway 的 Root Directory 留空即可，不需要再设置 `/ai-manga-doc-main`。


## 2026-09-30｜Markdown 支持

- 后台现在可以直接上传 `.md` 和 `.markdown` 文件。
- Bucket 直传和本地上传都支持 Markdown。
- 前台资料详情会为 Markdown 显示「在线预览」按钮。
- Markdown 预览会在站内转换为安全 HTML，支持标题、粗体、斜体、列表、引用、代码块、行内代码、分隔线和 http/https 链接。
- 原有 PDF、TXT、Word、PPT、Excel、压缩包等上传逻辑保持不变。
