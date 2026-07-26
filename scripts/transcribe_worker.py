import argparse
import json
import math
import sys

from faster_whisper import WhisperModel


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--compute-type", default="int8_float16")
    args = parser.parse_args()

    model = WhisperModel(args.model, device="cuda", compute_type=args.compute_type)
    print(json.dumps({"ready": True}, ensure_ascii=False), flush=True)

    for raw in sys.stdin:
        try:
            request = json.loads(raw)
            segments, _ = model.transcribe(
                request["path"],
                beam_size=5,
                vad_filter=True,
                condition_on_previous_text=False,
            )
            items = list(segments)
            text = "".join(segment.text for segment in items).strip()
            if items:
                avg_logprob = sum(segment.avg_logprob for segment in items) / len(items)
                no_speech = max(segment.no_speech_prob for segment in items)
                confidence = max(0.0, min(1.0, math.exp(avg_logprob) * (1.0 - no_speech)))
            else:
                confidence = 0.0
            response = {"id": request["id"], "text": text, "confidence": confidence}
        except Exception as exc:  # Worker must survive one bad media file.
            response = {"id": request.get("id") if "request" in locals() else None, "error": str(exc)}
        print(json.dumps(response, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
