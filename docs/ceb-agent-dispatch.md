# CB-AGENT-01 跨境电商前置机对接说明

状态：后端开发联调稿。接口和字段按当前代码编写，现场确认项集中在文末。

## 路由与实例配置

| 业务 | 报文与操作 | route | 客户端目录 |
|---|---|---|---|
| 9610 订单、运单、清单 | CEB303、CEB505、CEB603 直接申报 | SZ_PUBLIC_DIRECT | 深圳公服。发送 `D:\SZEPORT\SendFile\Send`，接收 `D:\SZEPORT\ReceiveFile\Receive` |
| 9610 清单 | CEB603 暂存单一 | SW_INVENTORY_TEMP | 单一窗口清单模块。专用模块、发送和接收目录待确认 |
| 9710／9810 订单 | CEB303 直接申报 | SZ_PUBLIC_DIRECT | 与上表深圳公服路由共用实例配置 |
| 9710／9810 出口报关单 | DEC 暂存 | DECCUS001（原 DEC 协议） | 单一窗口现有 DEC OutBox 和 InBox |

深圳公服备份目录为 `D:\SZEPORT\SendFile\Bak\Eport`，失败目录为 `D:\SZEPORT\SendFile\Err\Eport`。目录由前置机配置。两个 route 值是本项目协议标识，由前置机映射到对应客户端。现有 DEC 接口和 DECCUS001 配置保持原样。

同一票 9710／9810 的订单 CEB303 与报关单 DEC 分别确认发送。DEC 继续使用原 `/admin-api/declaration/agent/tasks/pull` 和 `/receipts`，支持该业务的实例在 DEC 拉取配置显式加入 `"9710"`、`"9810"`。任务按原 `ClientSeqNo` 处理暂存回执。详见[原 DEC 前置机接口](./前置机对接接口文档.md)。

后端新配置前缀为 `yudao.declaration.ceb-dispatch`，按租户和路由配置。空配置时禁止发送和领取。完成签名、渠道及实例验证后，再为测试租户启用。暂停发送时将 `send-enabled` 设为 false，保留实例名单可继续领取已入队任务、补报和上传回执。

```yaml
yudao:
  declaration:
    ceb-dispatch:
      routes:
        - tenant-id: 7                 # 示例租户
          route: SZ_PUBLIC_DIRECT
          send-enabled: false
          instances: [test-agent-01]
          accepted-codes:
            CEB303: ["2"]              # 现场订单成功样例。用于清单前置判断前，另核对比对规则
          rejected-codes:
            CEB303: ["-304014"]
        - tenant-id: 7
          route: SW_INVENTORY_TEMP
          send-enabled: false
          instances: []                # 确认实际接收目录后配置
          accepted-codes:
            CEB603: ["1"]              # 仅在该路由验证确实产出此回执后配置
```

## 前置机接口

前缀 `/admin-api/declaration/agent/ceb`。CEB 和 DEC 各用自己的接口路径，复用原 DEC 的公共响应、任务字段、状态上报和回执协议。客户端按接口族分别维护轮询和投递账本。

使用既有 `X-Agent-Key` 企业鉴权，由现有前置机总开关控制接口访问。首批使用租户密钥，实例必须属于该租户及路由的名单。公共 JSON 结构为 `{code,data,msg}`，业务成功为 `code=0`。心跳继续按原协议上报。

### 领取任务

`POST /tasks/pull`

```json
{
  "instanceName": "test-agent-01",
  "tradeModes": ["9610", "9710", "9810"],
  "route": "SZ_PUBLIC_DIRECT",
  "messageTypes": ["CEB303", "CEB505", "CEB603"],
  "batchSize": 5
}
```

每次领取一个路由。沿用 `instanceName`、`tradeModes`、`batchSize`，CEB 额外传 `route`，可选传 `messageTypes` 缩小范围。省略 `tradeModes` 时查询该路由下的 9610、9710、9810 任务。省略 `messageTypes` 时按该路由的全部报文类型领取。`batchSize` 沿用原接口的 1～100，缺省 5，由原前置机配置限制实际数量。成功响应的 `data.tasks` 是数组，无任务时为空。

```json
{
  "taskId": 101,
  "tenantId": 7,
  "orderId": null,
  "tradeMode": "9610",
  "businessModuleCode": null,
  "clientSeqNo": null,
  "messageType": "CEB603",
  "route": "SZ_PUBLIC_DIRECT",
  "operation": "DIRECT",
  "messageGuid": "552E6581-0731-4A0A-949A-7BD29AB3716F",
  "fileName": "CEB603_552E6581-0731-4A0A-949A-7BD29AB3716F.xml",
  "decXmlBase64": "<XML 原始字节的 Base64>",
  "xmlBase64": "<同一份 XML 原始字节的 Base64>",
  "xmlSha256": "<原始字节的 SHA-256 十六进制>",
  "dispatchToken": "<本轮领取令牌>",
  "leaseExpireAt": 1794277800000
}
```

`decXmlBase64` 沿用原任务字段名，CEB 接口中承载 CEB XML。`xmlBase64` 为此前 CEB 草案保留的同值别名，客户端可统一读 `decXmlBase64`。`operation` 为 `DIRECT` 或 `TEMP_SAVE`。租约沿用前置机配置，默认 10 分钟，`leaseExpireAt` 为毫秒时间戳。每份 CEB 文件最大 3 MiB。

`orderId` 在 9710／9810 订单任务中是报关主单 ID，9610 清单来源任务为空。`clientSeqNo` 是 DEC 流水号，CEB 中为空，CEB 投递轮次使用 `messageGuid`。`businessModuleCode` 由后端路由项的 `business-module-code` 配置，现场模块未确认时为空。CEB 按 `route` 映射目录，`DECCUS001` 仅用于原 DEC 接口。

### 落盘与结果上报

1. 按 route 选择目录，核对报文类型、文件名、租约及 XML 字节 SHA-256。CEB 以接口族、route、taskId、messageGuid、xmlSha256 记账，记录令牌、路径和文件名。DEC 保留原来的账本键。签名如由前置机完成，另记实际投递文件哈希。
2. 采用现场确认的临时文件约定，写完后原子重命名到最终路径。落盘后才上报 `OUTBOX_DROPPED`。只有确认文件未进入发送目录时上报 `FAILED`。
3. 已落盘但上报超时，重启后依据账本补报同一状态和令牌。租约过期且无落盘证据时进入 `DELIVERY_UNKNOWN`，先核对客户端账本和备份目录。后端仅允许已明确失败的任务重投同一文件。

`POST /tasks/{id}/status`

```json
{
  "instanceName": "test-agent-01",
  "dispatchToken": "<本轮领取令牌>",
  "status": "OUTBOX_DROPPED",
  "message": "已写入深圳公服发送目录"
}
```

成功返回 `data=true`。同一任务、实例、令牌和状态重复上报幂等。实例、令牌和状态冲突、未开通路由等业务校验使用 `1050004000` 和具体提示。既有鉴权错误沿用原协议。连接超时或服务端临时错误按退避策略重试。

### 上传回执

`POST /receipts`

```json
{
  "instanceName": "test-agent-01",
  "route": "SZ_PUBLIC_DIRECT",
  "taskId": 102,
  "tradeMode": "9710",
  "fileName": "CEB304_example.xml",
  "receivedAt": "2026-11-10 10:31:10",
  "receiptXmlBase64": "<原始回执字节的 Base64>"
}
```

从配置的接收目录按原始字节读取，等待文件稳定后上传，保留原文件。Base64 最长 4,194,304 字符。沿用原回执请求字段，CEB 额外传 `route`。仅在能可靠识别时提供 `taskId` 和 `tradeMode`，后端根据回执 XML 匹配。可选的 `receivedAt` 支持原日期时间字符串或毫秒时间戳，省略时使用服务端接收时间。

回执响应保留原字段 `matched`、`taskId`、`customsStatus`、`duplicate`，新增 `receiptId`、`returnStatus`。CEB 的 `customsStatus` 为空，`returnStatus` 是 CEB 原始码，前端业务进度仍查 CEB 批次。重复上传同一租户、路由和字节哈希的回执时，返回原记录和 `duplicate=true`。已留档但未匹配时，返回 `matched=false` 和空 `taskId`。

```json
{
  "code": 0,
  "data": {
    "matched": true,
    "taskId": 102,
    "customsStatus": null,
    "duplicate": false,
    "receiptId": 501,
    "returnStatus": "2"
  },
  "msg": ""
}
```

- CEB304 用订单号、电商平台代码和电商企业代码匹配。
- CEB506 用运单号和物流企业代码匹配。
- CEB604 用企业内部编号、订单号、申报企业代码、电商平台代码、电商企业代码和统计类型匹配。
- 多轮无法唯一匹配时留档。未知状态码保留原始值。回执摘要保留 returnTime、returnInfo，原始 XML 原样留档。每个任务首次已配置的业务结果用于进度展示，后续状态仍可从回执历史查看。订单回执附带的报关后续信息首批只留档。

### 样例核对结果

| 实际样例 | returnStatus | returnInfo 摘要 | 当前处理 |
|---|---|---|---|
| CEB304 订单申报 | 2 | 订单新增申报成功 | 现场渠道确认后可配置为订单受理。用于 9610 比对前置判断时需核对渠道规则。 |
| CEB304 订单旧报文 | -304014 | 订单新增申报失败，旧报文不处理 | 当前发送轮次拒绝，保留原因和原回执。 |
| CEB604 清单暂存 | 1 | 清单新增暂存成功 | 仅用于确认的暂存路由，显示清单已暂存。 |

## 管理端接入

前缀 `/admin-api/declaration/cross-border/dispatch`，沿用现有跨境应用登录权限。确认发送仅创建待投递任务。现有预览、下载接口继续使用原参数。

- `POST /lists/send` 接收 `{id,version,channelId,messageType,operation,requestId}`。id、version 为 9610 清单及版本，channelId 可省略以沿用现有渠道解析。订单 CEB303、运单 CEB505 分别直报，清单 CEB603 按按钮选择 DIRECT 或 TEMP_SAVE。直报清单按当前清单及相同申报渠道查询对应订单和运单的受理结果。
- `POST /orders/send` 接收现有 9710／9810 订单 XML 请求体，另传 `Idempotency-Key`。确认发送按弹窗最终值生成。本期支持新增报送。
- `GET /batches/{id}` 查询单批次任务。 `GET /batches?source=CEB_LIST&sourceId=...` 或 `source=CROSS_BORDER_ORDER` 查询最近 20 批。
- `POST /batches/{batchId}/tasks/{taskId}/retry` 重投确认未落盘的失败任务。
- `GET /receipts?taskId=...` 查询该任务最近 50 条回执摘要，省略 taskId 时查询待核对回执。beforeId 用于翻页。
- 任务的传输状态有 READY、DISPATCHED、DROPPED、FAILED、DELIVERY_UNKNOWN。业务状态有 PENDING、ACCEPTED、STAGED、REJECTED。页面按两列显示，DROPPED 表示文件已落盘。状态回报晚于业务回执时保留已记录的业务结果。

## 现场联调待完成

- 深圳公服的实际文件名、编码、签名要求及签名责任，CEB506 样例，CEB604 直报样例，以及订单和运单满足清单比对的状态。
- 9610 清单暂存的单一窗口专用模块、收发目录、文件和签名要求。已有暂存成功样例可核对字段及状态，现场需再核对实际投递路由。
- 前置机现场验证原子落盘、落盘后重启补报、目录不可写、回执重复与乱序。按路由记录实测配置和结果。
- 上线前在目标环境审核并应用新增脚本 `sql/mysql/20261110_declaration_ceb_dispatch_mysql57.sql`。脚本只创建跨境投递批次、任务、回执表。

