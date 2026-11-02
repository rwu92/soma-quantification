#!/bin/sh
# usage: loao.sh RUNDIR  (env ITERS SIGMA CH pass through)
for a in ${FOLDS:-15 16 17 18 19}; do ./tv/bin/python -I cnn/train.py data "$1" $a || exit 1; done
