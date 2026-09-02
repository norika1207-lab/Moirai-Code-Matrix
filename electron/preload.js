// preload 目前用不到，留作以後橋接系統 API 用
const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
});
