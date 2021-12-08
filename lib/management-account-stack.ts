import * as cdk from '@aws-cdk/core';
import { Code, Function, Runtime } from '@aws-cdk/aws-lambda';
import { Effect, ManagedPolicy, PolicyDocument, PolicyStatement, Role, ServicePrincipal } from '@aws-cdk/aws-iam';
import { Provider } from '@aws-cdk/custom-resources';
import { RetentionDays } from '@aws-cdk/aws-logs';
import { CfnCapabilities, CfnStackSet, CustomResource } from '@aws-cdk/core';
import { Subscription, SubscriptionProtocol, Topic, TopicPolicy } from '@aws-cdk/aws-sns';
import { AwsOrganizationsEventBridgeSetupMemberStack } from './member-account-stack';
import { Trail } from '@aws-cdk/aws-cloudtrail';
import { CfnEventBus, CfnEventBusPolicy, Rule } from '@aws-cdk/aws-events';
import { LambdaFunction } from '@aws-cdk/aws-events-targets';

export class AwsOrganizationsEventBridgeSetupManagementStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create new CloudTrail trail for management API Calls.
    new Trail(this, 'ManagementAPITrail');

    // Event Bus
    const eventBus = new CfnEventBus(this, 'CentralEventBus', {
      name: 'CentralEventBus'
    });
    const eventBusPolicy = new CfnEventBusPolicy(this, 'EventBusPolicy', {
      eventBusName: eventBus.name,
      statementId: 'AllowPutEventsWithinOrganizationAccounts',
      action: 'events:PutEvents',
      principal: '*',
      condition: {
        key: 'aws:PrincipalOrgID',
        type: 'StringEquals',
        value: process.env.ORGANIZATION_ID
      }
    })
    eventBusPolicy.addDependsOn(eventBus);


    // Create SNS topic and Email subscription.
    const topic = new Topic(this, 'SNSTopic', {
      topicName: 'EventBridgeTopic',
    })
    const topicPolicy = new TopicPolicy(this, 'TopicPolicy', {
      topics: [topic],
    });
    topicPolicy.document.addStatements(new PolicyStatement({
      actions: ['sns:Publish'],
      principals: [new ServicePrincipal('events.amazonaws.com')],
      resources: [topic.topicArn],
    }));
    new Subscription(this, 'EmailSubscription', {
      topic: topic,
      endpoint: process.env.SNS_EMAIL || '',
      protocol: SubscriptionProtocol.EMAIL
    })

    // Create Lambda function role with permissions to list organization members and update event rules.
    const updateMatchingruleLambdaRole = new Role(this, 'UpdateMatchingruleLambdaRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        updateEventBusPermissions: new PolicyDocument({
          statements: [
            new PolicyStatement({
              actions: [
                'events:putRule',
                'events:putTargets',
                'events:describeRule',
                'events:deleteRule',
                'events:removeTargets'
              ],
              effect: Effect.ALLOW,
              resources: [`arn:aws:events:${this.region}:${this.account}:rule/*`]
            }),
            new PolicyStatement({
              actions: [
                'organizations:ListAccountsForParent'
              ],
              effect: Effect.ALLOW,
              resources: [`arn:aws:organizations::${this.account}:ou/${process.env.ORGANIZATION_ID}/${process.env.ORGANIZATION_UNIT_ID}`]
            })
          ]
        })
      },
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
      ]
    })

    // Create Lambda function which creates EventBridge Rule with all member accounts.
    const updateRuleFunction = new Function(this, 'UpdateMatchingRuleLambda', {
      runtime: Runtime.NODEJS_14_X,
      handler: 'update-matching-rules-management.handler',
      logRetention: 1,
      timeout: cdk.Duration.minutes(10),
      environment: {
        REGION: process.env.REGION || '',
        ORGANIZATION_UNIT_ID: process.env.ORGANIZATION_UNIT_ID || '',
        SNS_TOPIC_ARN: topic.topicArn,
        EVENT_BUS_NAME: eventBus.name
      },
      role: updateMatchingruleLambdaRole,
      code: Code.fromAsset('lib/lambda'),
    })

    // configure custom resource based on Lambda.
    const customProviderUpdateMatchingRule = new Provider(this, 'UpdateMatchingRuleCustomProvider', {
      onEventHandler: updateRuleFunction,
      logRetention: RetentionDays.ONE_DAY,
    })
    new CustomResource(this, 'UpdateMatchingRuleCustomResource', {
      serviceToken: customProviderUpdateMatchingRule.serviceToken
    })

    // EventBridge to trigger updateRuleFunction Lambda whenever a new account is added or removed from the organization.
    new Rule(this, 'AWSOrganizationAccountMemberChangesRule', {
      description: 'Triggers Update Matching rule Lambda whenever a new account is added to the organization or removed.',
      ruleName: 'AWSOrganizationAccountMemberChangesRule',
      eventPattern: {
        source: ['aws.organizations'],
        detailType: ['AWS API Call via CloudTrail'],
        detail: {
          eventSource: ['organizations.amazonaws.com'],
          eventName: [
            'RemoveAccountFromOrganization',
            'MoveAccount'
          ]
        }
      },
      targets: [
        new LambdaFunction(updateRuleFunction)
      ]
    });

    // StackSet in the management account used to create and deploy the member stack in each member account.
    const stage = new cdk.Stage(this, "Stage")
    new AwsOrganizationsEventBridgeSetupMemberStack(stage, 'MemberEventBridgeStack')
    const stackSetTemplateObj = stage.synth().stacks[0].template

    new CfnStackSet(this, 'MemberStackSet', {
      autoDeployment: {
        enabled: true,
        retainStacksOnAccountRemoval: false
      },
      stackSetName: 'MemberStackEventBridgeSetup',
      capabilities: [CfnCapabilities.NAMED_IAM],
      templateBody: JSON.stringify(stackSetTemplateObj),
      permissionModel: 'SERVICE_MANAGED',
      parameters: [
        {
          parameterKey: 'eventBusName',
          parameterValue: eventBus.name
        }
      ],
      operationPreferences: {
        maxConcurrentCount: 10
      },
      stackInstancesGroup: [
        {
          deploymentTargets: {
            organizationalUnitIds: [process.env.ORGANIZATION_UNIT_ID || '']
          },
          regions: [process.env.REGION || '']
        }
      ]
    })
  }
}
