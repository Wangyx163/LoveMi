# LoveMi V1.4 ????

兴趣取并集，宿主需对数据库当前兴趣做原子合并，不覆盖。画像及所需故事生成成功后才发出 onProfileReady。失败进入 PROFILE_FAILED，点击重试只重跑失败模块；无信息时可继续补充 Q12。回写重试复用已生成事件。身高目标统一±5，180左右为175–185；明确上下限和区间保留原值。

## Implementation

- `src/profile_mapper.js`: 14 controls, 100 interest IDs and aliases; merge interests.
- `src/profile_content_composer.js`, `prompts/PC_system.txt`, `prompts/PC_user.txt`: faithful story compression and original Q/A selection.
- `src/engine.js`: generation gate, failed-node retry cache and Q12 supplement route.
- `src/business_events.js`: final event with `write_modes.interest_ids = "merge"`; idempotent delivery.
- `assets/app.js`: retry and supplement actions; no final card on generation failure.

## Host integration

`window.lovemiBusinessAdapter.registrationProfile`: `{height_cm?: number, seek?: string, interest_ids?: number[]}`.

`onProfileReady(event)` must apply interest union atomically against the latest stored IDs, patch mapped fields, and write supplied content. Return `{accepted:true, profile_version:event.profile_version}` only after successful persistence. No business database endpoint has been supplied; this release implements the adapter contract, not a fabricated database connection.

## Validation

`npm test` passed offline, including 22 mapping/writeback regression groups. No paid model requests were made.
