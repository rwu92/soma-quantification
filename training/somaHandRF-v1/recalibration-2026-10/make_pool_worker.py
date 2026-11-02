"""make_pool_worker.py <app worker.js> <out.js>: the worker with a poolAll parameter, under which
the hand-count classifier and the legacy forests record their verdicts instead of dropping candidates."""
import sys
src = open(sys.argv[1]).read()
def rep(a, b):
    global src
    assert src.count(a) == 1, a; src = src.replace(a, b)
rep("    if(handRf&&!(handRf.prob[qi]>=handRf.threshold)){rej.model=(rej.model||0)+1;continue;}",
    "    if(handRf&&!p.poolAll&&!(handRf.prob[qi]>=handRf.threshold)){rej.model=(rej.model||0)+1;continue;}")
rep("    if(handRf){cell.modelScore=handRf.prob[qi];cells.push(cell);continue;}",
    "    if(handRf){cell.modelScore=handRf.prob[qi];cell.modelKeep=handRf.prob[qi]>=handRf.threshold;cells.push(cell);continue;}")
rep("""    cell.reviewQuality=rq;
    if(!(cell.reviewDonut&&isFinite(cell.reviewScore)&&cell.reviewScore>=REVIEW_DONUT_RF.threshold) && rq<REVIEW_QUALITY_RF.threshold){""",
"""    cell.reviewQuality=rq;
    if(p.poolAll){cell.legacyDrop=!(cell.reviewDonut&&isFinite(cell.reviewScore)&&cell.reviewScore>=REVIEW_DONUT_RF.threshold)&&rq<REVIEW_QUALITY_RF.threshold;
      if(cell.reviewDonut&&isFinite(cell.reviewScore)&&cell.reviewScore>=REVIEW_DONUT_RF.threshold){const rs=reviewRescueOutputScore(cell,p);cell.reviewRescueQuality=rs;if(rs<REVIEW_RESCUE_OUTPUT.threshold)cell.legacyDrop=true;}
      cells.push(cell);continue;}
    if(!(cell.reviewDonut&&isFinite(cell.reviewScore)&&cell.reviewScore>=REVIEW_DONUT_RF.threshold) && rq<REVIEW_QUALITY_RF.threshold){""")
open(sys.argv[2], 'w').write(src)
