# 跨境电商申报前端对接指南

适用版本为 CB-AGENT-01，更新日期为 2026-11-10。本文覆盖 9610 清单页和 9710／9810 报关单详情页。下表中的路径相对于 `/admin-api`，已配置该前缀的请求客户端可直接使用。

## 页面操作与接口

| 页面 | 按钮 | 发送报文 | 管理端入口 | 结果查询 |
|---|---|---|---|---|
| 9610 清单 | 订单直接申报 | CEB303 | `POST /declaration/cross-border/dispatch/lists/send` | CEB 批次和回执 |
| 9610 清单 | 运单直接申报 | CEB505 | 同上 | CEB 批次和回执 |
| 9610 清单 | 清单直接申报 | CEB603 | 同上 | CEB 批次和回执 |
| 9610 清单 | 清单暂存单一 | CEB603 | 同上 | CEB 批次和回执 |
| 9710／9810 详情 | 订单申报 | CEB303 | `POST /declaration/cross-border/dispatch/orders/send` | CEB 批次和回执 |
| 9710／9810 详情 | 报关单申报 | DEC | `POST /declaration/submit/customs/save?orderId={id}` | 原 DEC 暂存回执 |

9710／9810 的「报关单申报」通过原流程把 DEC 投递到单一窗口暂存。按钮建议沿用现有出口页面的「暂存单一窗口」文案，或者在确认弹窗写明提交后先等待暂存回执。同一票的「订单申报」走深圳公服，独立显示结果。

浏览器使用现有登录凭证、租户头和关贸通应用权限。发送时传业务参数，由后端生成并保存 XML。前置机随后领取并落盘。预览和下载继续使用原接口，页面可在确认前预览校验问题。

前置机继续复用原 DEC 的公共传输字段，CEB 使用独立投递路径和路由。浏览器侧的发送、批次查询及状态字段沿用本文的管理端接口。

## 9610 清单页

### 确认发送

`POST /admin-api/declaration/cross-border/dispatch/lists/send`

```json
{
  "id": 401,
  "version": 9,
  "channelId": 31,
  "messageType": "CEB603",
  "operation": "DIRECT",
  "requestId": "c53c13ed-bd88-4228-8dda-564c3733cc26"
}
```

| 字段 | 说明 |
|---|---|
| `id`、`version` | 当前已保存清单的 ID 和最新版本，从清单详情获取。 |
| `channelId` | 申报渠道 ID。省略时按现有逻辑解析默认渠道。 |
| `messageType`、`operation` | 按下表从按钮固定取值。 |
| `requestId` | 本次确认的请求标识，1～64 位字母、数字、下划线或连字符。建议使用 UUID。 |

| 按钮 | messageType | operation | 投递去向 |
|---|---|---|---|
| 订单直接申报 | `CEB303` | `DIRECT` | 深圳公服 |
| 运单直接申报 | `CEB505` | `DIRECT` | 深圳公服 |
| 清单直接申报 | `CEB603` | `DIRECT` | 深圳公服 |
| 清单暂存单一 | `CEB603` | `TEMP_SAVE` | 单一窗口清单通道 |

先提交同一清单、同一申报渠道下的订单和运单，待对应任务的业务回执达到受理条件后，再提交清单直接申报。后端逐份检查前置条件，订单或运单仍在排队、仅已落盘、或已被拒绝时，显示后端返回的提示。清单暂存单一由独立路由控制启用。

一次确认可能生成多份 XML，订单按订单号分组，运单按运单号分组，清单按订单号和运单号组合分组。一个批次包含多条任务，页面展示每份任务的状态。

## 9710／9810 订单申报

1. 保存原票并获取最新 `draftVersion`。
2. 调用 `POST /admin-api/declaration/cross-border/orders/extract-ticket`，请求体为 `{id,draftVersion}`，用返回数据预填订单弹窗。
3. 用户确认弹窗最终值后，可先调用 `POST /admin-api/declaration/cross-border/orders/xml/preview`。当 `code=0` 且 `data.ready=true` 时可展示 XML 及警告。遇到 `ready=false` 时展示 `data.issues`。
4. 用户确认发送时调用 `POST /admin-api/declaration/cross-border/dispatch/orders/send`。请求体与订单 XML 预览相同，同时传请求头 `Idempotency-Key: <本次确认的 UUID>`。

```json
{
  "id": 1001,
  "draftVersion": 4,
  "channelId": 31,
  "head": {
    "appType": "1",
    "appStatus": "2",
    "orderNo": "ORDER-001",
    "ebpCode": "0012345679",
    "ebpName": "示例平台或海外仓",
    "ebcCode": "0012345678",
    "ebcName": "示例电商企业",
    "goodsValue": "6.25",
    "freight": "0",
    "currency": "502"
  },
  "items": [
    {
      "itemNo": "SKU-001",
      "itemName": "示例商品",
      "unit": "011",
      "currency": "502",
      "qty": "2",
      "price": "3.125",
      "totalPrice": "6.25"
    }
  ]
}
```

`id` 是现有报关主单 ID。后端根据主单生成 9710 的订单类型 `B` 或 9810 的 `W`。发送入口当前支持新增报送，`appType=1`。传弹窗最终值，金额和数量用十进制字符串，币制及单位保留三位代码及前导零。字段明细见[订单报文生成](frontend-cross-border-order-xml.md)和[提取本票信息](frontend-cross-border-extract-ticket.md)。

同一次 CEB 发送遇到超时或页面重复点击时，保留原请求体及原请求标识重试。若用户修改了内容再发起确认，使用新的请求标识。收到批次后通过查询接口刷新进度。

## CEB 进度、回执和重投

以下接口均使用 `/admin-api/declaration/cross-border/dispatch` 前缀。发送成功与查询批次均返回公共结构 `{code,data,msg}`。当 `code=0` 时，示例 `data` 如下。

```json
{
  "batchId": 70,
  "sourceType": "CEB_LIST",
  "sourceId": 401,
  "sourceVersion": 9,
  "route": "SZ_PUBLIC_DIRECT",
  "tasks": [
    {
      "taskId": 101,
      "messageType": "CEB603",
      "fileName": "CEB603_552E6581-0731-4A0A-949A-7BD29AB3716F.xml",
      "transportStatus": "READY",
      "businessStatus": "PENDING",
      "returnStatus": null,
      "agentMessage": null
    }
  ]
}
```

| 用途 | 方法和路径 |
|---|---|
| 刷新当前批次 | `GET /batches/{batchId}` |
| 页面重开时恢复历史 | `GET /batches?source=CEB_LIST&sourceId={listId}` 或 `GET /batches?source=CROSS_BORDER_ORDER&sourceId={orderId}`，最近 20 批 |
| 查看任务回执 | `GET /receipts?taskId={taskId}`，每页最多 50 条。下一页传本页最后一条的 `receiptId` 作为 `beforeId`。 |
| 重投确认未落盘的任务 | `POST /batches/{batchId}/tasks/{taskId}/retry`，返回刷新后的批次。仅对 `FAILED` 且 `businessStatus=PENDING` 的任务提供入口，由后端校验。 |

页面分两列展示任务结果。

| transportStatus | 文案 |
|---|---|
| `READY` | 待投递 |
| `DISPATCHED` | 前置机已领取 |
| `DROPPED` | 文件已写入发送目录 |
| `FAILED` | 投递失败，可展示 `agentMessage` |
| `DELIVERY_UNKNOWN` | 投递结果待核对，提供刷新入口 |

| businessStatus | 文案 |
|---|---|
| `PENDING` | 待业务回执或待核对 |
| `ACCEPTED` | 渠道回执已受理 |
| `STAGED` | 清单暂存成功 |
| `REJECTED` | 业务回执拒绝 |

回执详情展示 `returnStatus`、`returnInfo`、`returnTime`。其中 `returnTime` 是回执中的原始时间字符串，`receivedAt` 是系统接收时间的毫秒时间戳。回执摘要里的 `messageType` 对应发送的报文类型，例如 CEB604 回执在该字段显示为 `CEB603`。后续业务阶段以回执历史为准。批次内各文件分别展示，有未完成项时保留明细。

页面打开时可对待领取、投递中和待回执批次定时刷新，离开页面后停止。路由未开通、草稿版本过期或生成校验失败时，展示公共响应的 `msg`。遇到版本过期，刷新单据并由用户重新确认。

## 9710／9810 出口 DEC 报关单

以下接口使用原 `/admin-api/declaration/submit` 前缀。复用现有普通出口页面的 DEC 按钮和状态处理，传同一票的报关主单 `orderId`。

| 操作 | 方法和路径 | 处理方式 |
|---|---|---|
| 下载 DEC 文件 | `POST /export/dec_xml?orderId={id}` | 以 Blob 接收 XML，`xml` 是兼容别名。 |
| 创建单一窗口暂存任务 | `POST /customs/save?orderId={id}` | `/customs/upload` 为兼容入口，单次操作调用其中一个。 |
| 查询暂存回执 | `GET /customs/receipt?orderId={id}` | 读取 `data.customs_status`，缺失时读 `data.code`，并展示 `data.message`。 |

保存任务后，`data.customs_status=READY` 表示待投递，`data.success=true` 表示任务创建成功。收到 `RECEIPT_PENDING` 表示已投递等待暂存回执，收到 `SUCCESS` 时显示「单一窗口暂存成功」。其他状态复用现有[报关状态前端约定](declaration-customs-status-frontend.md)。

DEC 生成后的出口方向为 `IEFlag=E`，监管方式保持本票的 `9710` 或 `9810`。DEC 使用自己的 `client_seq_no` 查询链路，CEB 使用自己的 `batchId` 和 `taskId`。前端分别渲染订单与报关单的状态。导出 `import_agr` 对 9710／9810 返回 `1050000033`。

## 前端联调验收

- 9610 页面核对四个按钮的报文和操作组合，验证先订单及运单、后清单直报的提示，以及多份报文的部分结果展示。
- 9710 和 9810 页面各验证一票，分别触发 CEB303 订单和 DEC 报关单，并核对各自的查询接口和状态。
- 验证 CEB 发送超时后使用原请求标识重试，刷新页面后通过来源单据恢复历史批次。
- 验证下载、待投递、已落盘、业务回执和 DEC 暂存成功的页面文案。现场路由是否启用由部署配置决定，测试以联调租户配置为准。

现场目录及 Windows 客户端协议见[前置机对接说明](ceb-agent-dispatch.md)。
