#!/bin/sh

_env__validate
RC=$?
if [ $RC -ne 0 ] ; then
	exit $RC
fi
bun i
(cd app/brookebrodack-site && NODE_ENV=production bun -b run build)
