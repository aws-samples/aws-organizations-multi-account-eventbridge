#!/usr/bin/env bash

if [[ $# -ge 5 ]]; then
    export CDK_MANAGEMENT_ACCOUNT=$1
    export REGION=$2
    export ORGANIZATION_ID=$3
    export ORGANIZATION_UNIT_ID=$4
    export SNS_EMAIL=$5
    shift; shift; shift; shift; shift

    npx cdk synth "$@"
    exit $?
else
    echo 1>&2 "Provide management account id, region, organization id, organization unit id and email as first five arguments."
    echo 1>&2 "Additional args are passed through to cdk deploy."
    exit 1
fi