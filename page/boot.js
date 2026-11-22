(async () => {
  let options = {};
  try {
    await magpie.ready;
    options = await magpie.options.get();
  } catch {
    document.getElementById('status').textContent = '无法连接 Magpie，请重新打开页面。';
    return;
  }
  const port = Number(options.port ?? 3479);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    document.getElementById('status').textContent = '插件端口无效，请在插件选项中设置 1024–65535 之间的 port。';
    return;
  }
  const host = location.hostname.toLowerCase();
  if (host && host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]') {
    document.getElementById('status').textContent = 'Prompt 日记仅支持在运行 Magpie 的本机查看。';
    return;
  }
  const status = document.getElementById('status');
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = '重试';
  retry.hidden = true;
  status.after(retry);
  let timeout;
  function connect() {
    clearTimeout(timeout);
    status.textContent = '正在打开 Prompt 日记…';
    retry.hidden = true;
    timeout = setTimeout(() => {
      status.textContent = `无法连接本地服务（端口 ${port}），请检查插件是否启用或端口是否被占用。`;
      retry.hidden = false;
    }, 5000);
    location.replace(`http://127.0.0.1:${port}/`);
  }
  retry.addEventListener('click', connect);
  connect();
})();
