import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
// Metro 设计层（Android 宿主专用）。
// 必须在 styles.css 之后导入：令牌覆盖靠「同优先级时后者胜」和「未分层规则胜过分层规则」，
// 顺序反了会失效。该文件里每一条规则都限定在 :root[data-aijob-host='android'] 之下，
// 桌面端不设置这个属性，因此对本文件而言桌面端是完全无副作用的。
import './styles-metro.css';
import { applyHostAttributes } from './lib/platform';

// 渲染之前先把宿主身份写到 <html> 上。
// 放到渲染之后做，首帧会按桌面端配色画一遍再切过去，肉眼可见地闪一下。
applyHostAttributes();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
