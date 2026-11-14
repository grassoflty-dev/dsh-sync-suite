# phone-a 设备目录（示例）

```
phone-a/
  schedules/YYYY-MM-DD.jsonl     # 一行一事件，只追加
  attachments/<sha256>.png       # 手写分页截图，按 sha256 去重
```

由 ArkUI-X 日程助手写入，只写本设备目录，永不 merge 其他设备。
