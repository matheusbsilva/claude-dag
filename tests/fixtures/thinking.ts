// Distilled from a spike recording of real hook payloads (Claude Code 2.1.296); paths scrubbed.
import type { DagEvent } from '../../hooks/model'

export const thinking: DagEvent[] = [
 {
  "type": "turnStart",
  "turnId": "8aad3d17-2d35-4ab7-a72f-dffd1730b895",
  "text": "ultrathink: is 2^61-1 prime? Answer yes/no with one-line reason.",
  "at": 1791661655682
 },
 {
  "type": "stepStart",
  "turnId": "8aad3d17-2d35-4ab7-a72f-dffd1730b895",
  "index": 0,
  "model": "claude-opus-5-5",
  "at": 1791661655717
 },
 {
  "type": "block",
  "uuid": "d7401607-6d07-4082-8484-b0bfb869a5d4:0",
  "kind": "thinking",
  "text": "",
  "at": 1791661661437
 },
 {
  "type": "block",
  "uuid": "be97ec3d-9434-407e-9277-e5c971375cc2:0",
  "kind": "text",
  "text": "(recorded)",
  "at": 1791661661884
 },
 {
  "type": "stepEnd",
  "turnId": "8aad3d17-2d35-4ab7-a72f-dffd1730b895",
  "index": 0,
  "at": 1791661661906
 },
 {
  "type": "turnEnd",
  "turnId": "8aad3d17-2d35-4ab7-a72f-dffd1730b895",
  "reason": "answer",
  "answer": "**Yes.** 2^61 \u2212 1 = 2,305,843,009,213,693,951 is the 9th Mersenne prime, proven prime by Ivan Pervushin in 1883 and confirmed by the Lucas\u2013Lehmer test.",
  "at": 1791661663633
 }
]
