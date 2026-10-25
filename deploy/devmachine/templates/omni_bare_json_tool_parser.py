"""Qwen2.5-Omni（vLLM 0.32）用的工具调用解析器插件。

为什么要自己写：实测这个模型在套上 Qwen2.5 官方 tools 模板后，**能正确产出工具调用，
但不带 `<tool_call>` 标签**，直接吐裸 JSON：

    {"name": "notify", "arguments": {"warning": "..."}}

内置的 `hermes` 解析器要求标签，于是工具调用会被当成普通文本返回（brain 就收不到
`notify` 了）。这个插件两种形态都认：有标签按标签切，没有就扫描括号平衡的 JSON 片段。

用法（见 deploy/k8s/08-chat.yaml）：
    --tool-parser-plugin /templates/omni_bare_json_tool_parser.py
    --tool-call-parser omni_bare_json
"""
import json
from collections.abc import Sequence

from vllm.entrypoints.generate.base.protocol import (
    DeltaFunctionCall,
    DeltaMessage,
    DeltaToolCall,
    ExtractedToolCallInformation,
    FunctionCall,
    ToolCall,
)
from vllm.entrypoints.openai.chat_completion.protocol import ChatCompletionRequest
from vllm.renderers.chat_utils import make_tool_call_id
from vllm.tool_parsers.abstract_tool_parser import ToolParser, ToolParserManager
from vllm.tool_parsers.utils import partial_tag_overlap

START = "<tool_call>"
END = "</tool_call>"


def _balanced_json_spans(text: str) -> list[tuple[int, int]]:
    """扫描所有括号平衡的 JSON 片段，返回 [(start, end)]。忽略字符串里的括号。"""
    spans: list[tuple[int, int]] = []
    stack: list[str] = []
    start = -1
    in_str = False
    esc = False
    for i, ch in enumerate(text):
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch in "{[":
            if not stack:
                start = i
            stack.append(ch)
        elif ch in "}]":
            if not stack:
                continue
            opened = stack.pop()
            if (opened, ch) not in (("{", "}"), ("[", "]")):
                stack.clear()
                start = -1
                continue
            if not stack:
                spans.append((start, i + 1))
                start = -1
    return spans


def _load_calls(text: str) -> list[dict]:
    """从一段文本里抽出工具调用 {"name":..., "arguments":...}。"""
    calls: list[dict] = []
    for begin, end in _balanced_json_spans(text):
        try:
            obj = json.loads(text[begin:end])
        except Exception:
            continue
        for item in obj if isinstance(obj, list) else [obj]:
            if isinstance(item, dict) and isinstance(item.get("name"), str):
                args = item.get("arguments", item.get("parameters", {}))
                calls.append({"name": item["name"], "arguments": args})
    return calls


def _extract(text: str) -> list[dict]:
    """先按 <tool_call> 标签切；没有标签就把整段当候选。"""
    segments: list[str] = []
    pos = 0
    while True:
        begin = text.find(START, pos)
        if begin == -1:
            break
        body_start = begin + len(START)
        body_end = text.find(END, body_start)
        segments.append(text[body_start : body_end if body_end != -1 else len(text)])
        pos = body_end + len(END) if body_end != -1 else len(text)
    if segments:
        calls: list[dict] = []
        for seg in segments:
            calls.extend(_load_calls(seg))
        return calls
    return _load_calls(text)


@ToolParserManager.register_module("omni_bare_json")
class OmniBareJsonToolParser(ToolParser):
    def __init__(self, tokenizer, tools=None):
        super().__init__(tokenizer, tools)
        self._tool_mode = False
        self._tool_sent = False
        self._sent_content = 0

    def extract_tool_calls(
        self, model_output: str, request: ChatCompletionRequest
    ) -> ExtractedToolCallInformation:
        calls = _extract(model_output)
        if not calls:
            return ExtractedToolCallInformation(
                tools_called=False, tool_calls=[], content=model_output
            )
        cut = model_output.find(START)
        if cut == -1:
            spans = _balanced_json_spans(model_output)
            cut = spans[0][0] if spans else len(model_output)
        content = model_output[:cut].strip()
        return ExtractedToolCallInformation(
            tools_called=True,
            tool_calls=[
                ToolCall(
                    type="function",
                    function=FunctionCall(
                        name=call["name"],
                        arguments=json.dumps(call["arguments"], ensure_ascii=False),
                    ),
                )
                for call in calls
            ],
            content=content or None,
        )

    def extract_tool_calls_streaming(
        self,
        previous_text: str,
        current_text: str,
        delta_text: str,
        previous_token_ids: Sequence[int],
        current_token_ids: Sequence[int],
        delta_token_ids: Sequence[int],
        request: ChatCompletionRequest,
    ) -> DeltaMessage | None:
        if self._tool_sent:
            return None

        stripped = current_text.lstrip()
        looks_like_call = (
            self._tool_mode
            or START in current_text
            or stripped.startswith("{")
            or stripped.startswith("[")
        )

        if looks_like_call:
            self._tool_mode = True
            # 参数是短 JSON，等它整体成形再一次性发出，不做逐字增量。
            # `_extract` 只认括号平衡且能 json.loads 的片段，所以拿到 calls 就意味着已经完整。
            calls = _extract(current_text)
            if not calls:
                return None
            call = calls[0]
            args = json.dumps(call["arguments"], ensure_ascii=False)
            self._tool_sent = True
            self.current_tool_id = 0
            self.prev_tool_call_arr = [{"name": call["name"], "arguments": args}]
            self.streamed_args_for_tool = [args]
            return DeltaMessage(
                tool_calls=[
                    DeltaToolCall(
                        index=0,
                        id=make_tool_call_id(),
                        type="function",
                        function=DeltaFunctionCall(
                            name=call["name"], arguments=args
                        ),
                    )
                ]
            )

        # 普通文本：透传，但要扣住可能是 "<tool_call>" 或 "{" 开头的尾巴
        overlap = partial_tag_overlap(current_text, START)
        sendable = len(current_text) - overlap
        while sendable > self._sent_content and current_text[sendable - 1] == "{":
            sendable -= 1
        if sendable > self._sent_content:
            chunk = current_text[self._sent_content : sendable]
            self._sent_content = sendable
            return DeltaMessage(content=chunk)
        return None
