"""The review agents and the orchestrator that chains them."""

from .pipeline import PipelineInput, ReviewPass, ReviewPipeline, summarize
from .tracing import Tracer

AGENT_LABELS = {
    "selling_points": "卖点提炼",
    "script_writer": "脚本生成",
    "rule_review": "规则审查",
    "model_review": "模型审查",
    "evidence_locator": "证据定位",
    "rewrite": "改写建议",
    "human_review": "人工终审",
}

__all__ = ["AGENT_LABELS", "PipelineInput", "ReviewPass", "ReviewPipeline", "Tracer", "summarize"]
