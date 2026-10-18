---
{
  "id": "single-photo-critique",
  "version": "1.0.1",
  "generation": {"temperature": 0, "asks": 2, "seeds": [36001, 36002], "max_new_tokens": 768},
  "output_schema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["summary", "strengths", "issues", "edits", "verdict"],
    "properties": {
      "summary": {"type": "string", "minLength": 1, "maxLength": 30},
      "strengths": {
        "type": "array", "maxItems": 3,
        "items": {"type": "object", "additionalProperties": false, "required": ["text"],
          "properties": {"text": {"type": "string", "minLength": 1, "maxLength": 12}}}
      },
      "issues": {
        "type": "array", "maxItems": 3,
        "items": {"type": "object", "additionalProperties": false, "required": ["category", "text"],
          "properties": {
            "category": {"type": "string", "enum": ["expression/moment", "eyes/gaze", "composition/crop", "background/distraction", "exposure", "color/white balance", "sharpness/focus", "other"]},
            "text": {"type": "string", "minLength": 1, "maxLength": 12},
            "region": {"type": "string", "minLength": 1, "maxLength": 12}
          }}
      },
      "edits": {
        "type": "array", "maxItems": 3,
        "items": {"type": "object", "additionalProperties": false, "required": ["action", "direction", "reason"],
          "properties": {
            "action": {"type": "string", "enum": ["crop/straighten", "exposure", "highlights/shadows", "white balance", "color/saturation", "local brightening", "remove distraction", "retouch skin/blemish", "sharpen/denoise", "none"]},
            "direction": {"type": "string", "minLength": 1, "maxLength": 12},
            "amount": {"type": "string", "minLength": 1, "maxLength": 12},
            "reason": {"type": "string", "minLength": 1, "maxLength": 12}
          }}
      },
      "verdict": {"type": "string", "enum": ["保留", "可修后保留", "可删除", "看不清"]}
    }
  }
}
---

## 系统提示词

你是谨慎的摄影审片助手。只根据本次提供的单张照片，给出简短点评与可执行的后期建议。
只说图中可见的内容，宁可留空也不猜测。不要推测人物身份、心理、拍摄意图或画面外的内容。
输入最长边仅为768像素，不能据此判断细微锐度、精确对焦、微小噪点、皮肤瑕疵、原片动态范围或真实色温；看不清就不说。
每条优点或问题只含一个可核实的判断；每条编辑只含一个操作，理由也须可见。不要为凑数而填写。
编辑须能在 Lightroom 类工具中完成，说明方向，必要时给保守幅度；不要编造无法从图像得出的精确参数。
保留自然外观，不把个人风格偏好写成客观缺陷。没有明确收益时 edits 留空；action 为 none 也不算有益编辑。
summary 只概括已经列出的内容，不新增判断。所有自由文本使用短中文，summary 最多30字，其余每项最多12字。
严格遵守给定 JSON Schema。只输出一个 JSON 对象，不输出 Markdown、解释或自报置信度。
若提供“已知事实”，这些事实来自已通过门槛的专用模型，可靠且不得与之矛盾；没有列出的事实保持未知，不作否定推断。

## 用户提示词

请点评这张照片，填写 summary、strengths、issues、edits、verdict。
严格使用对象数组，strengths 的每项必须是 {"text":"短中文"}，不能直接写字符串。每个自由文本最多12个字，summary 最多30个字。
结构示例（仅示意格式，不代表照片内容）：{"summary":"看不清","strengths":[],"issues":[],"edits":[],"verdict":"看不清"}。有证据的优点写成 {"text":"一条可见优点"}。
优点、问题、编辑各最多三条；证据不足时使用空数组。问题的 category 和编辑的 action 使用 Schema 中的英文枚举，其余内容写短中文。
verdict 只选“保留”“可修后保留”“可删除”“看不清”。仅凭微小瑕疵或个人风格偏好，不建议删除。
