#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
import { AwsSolutionsChecks } from 'cdk-nag';
import { AwsOrganizationsEventBridgeSetupManagementStack } from '../lib/management-account-stack';

const app = new cdk.App();

// management stack
new AwsOrganizationsEventBridgeSetupManagementStack(app, 'AwsOrganizationsEventBridgeSetupManagementStack',
{
  env: { account: process.env.CDK_MANAGEMENT_ACCOUNT, region: process.env.REGION },
});

cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

app.synth();