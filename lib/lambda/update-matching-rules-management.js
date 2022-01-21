'use strict'

const AWS = require('aws-sdk');

const organizationUnitId = process.env.ORGANIZATION_UNIT_ID;
const snsTopicArn = process.env.SNS_TOPIC_ARN;
const region = process.env.REGION;
const eventBusName = process.env.EVENT_BUS_NAME;

const organizationsClient = new AWS.Organizations({ region });
const eventBridgeClient = new AWS.EventBridge({ region });

// EventBridge Rule
const rule = {
  name: 'CentralEventBridgeRule',
  sources: ['aws.cloudwatch', 'aws.config', 'aws.guardduty'],
  description: 'The Rule propagates all Amazon CloudWatch Events, AWS Config Events, AWS Guardduty Events to the eventbus'
}

exports.handler = async function (event, context) {
  console.info("EVENT\n" + JSON.stringify(event, null, 2))
  const eventName = event.detail && event.detail.eventName;
  const accountIds = await listAccounts();

  // Cloudformation Custom resource event
  switch (event.RequestType) {
    case "Create":
      await putRule(accountIds);
      break;
    case "Update":
      await putRule(accountIds);
    case "Delete":
      await deleteRule()
      break;
  }

  // New AWS Account moved to the organization unit or out it.
  if (eventName === 'MoveAccount' || eventName === 'RemoveAccountFromOrganization') {
    await putRule(accountIds);
  }
}

async function putRule(accounts) {
  console.log(accounts)
  if (accounts.length === 0) {
    return;
  }
  await eventBridgeClient.putRule({
    Name: rule.name,
    Description: rule.description,
    EventBusName: eventBusName,
    EventPattern: JSON.stringify({
      account: accounts,
      source: rule.sources
    })
  }).promise();
  await eventBridgeClient.putTargets({
    Rule: rule.name,
    EventBusName: eventBusName,
    Targets: [
      {
        Arn: snsTopicArn,
        Id: `snsTarget-${rule.name}`
      }
    ]
  }).promise();
}

async function deleteRule() {
  await eventBridgeClient.removeTargets({
    Rule: rule.name,
    EventBusName: eventBusName,
    Ids: [`snsTarget-${rule.name}`]
  }).promise()
  await eventBridgeClient.deleteRule({
    Name: rule.name,
    EventBusName: eventBusName
  }).promise();
}

async function listAccounts() {
  const accounts = [];
  let nextToken = true
  const params = {
    ParentId: organizationUnitId
  }

  while (nextToken) {
    if (typeof nextToken === 'string' || nextToken instanceof String) {
      params.NextToken = nextToken
    }

    const accountsRes = await organizationsClient.listAccountsForParent(params).promise()
    Array.prototype.push.apply(accounts, accountsRes.Accounts)

    if ('NextToken' in accountsRes) {
      nextToken = accountsRes.NextToken
    } else {
      nextToken = false
    }
  }

  return accounts.map(account => account.Id)
}
