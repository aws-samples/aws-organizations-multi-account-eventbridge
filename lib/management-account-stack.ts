import * as cdk from '@aws-cdk/core';
import { Code, Function, Runtime } from '@aws-cdk/aws-lambda';
import { Effect, ManagedPolicy, PolicyDocument, PolicyStatement, Role, ServicePrincipal } from '@aws-cdk/aws-iam';
import { Provider } from '@aws-cdk/custom-resources';
import { CfnCapabilities, CfnStackSet, CustomResource, RemovalPolicy } from '@aws-cdk/core';
import { Subscription, SubscriptionProtocol, Topic, TopicPolicy } from '@aws-cdk/aws-sns';
import { AwsOrganizationsEventBridgeSetupMemberStack } from './member-account-stack';
import { Trail } from '@aws-cdk/aws-cloudtrail';
import { CfnEventBus, CfnEventBusPolicy, Rule } from '@aws-cdk/aws-events';
import { LambdaFunction } from '@aws-cdk/aws-events-targets';
import { StandardBucket } from './constructs/standard-bucket';
import { Key } from '@aws-cdk/aws-kms';
import { NagSuppressions } from 'cdk-nag';

export class AwsOrganizationsEventBridgeSetupManagementStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const centralEventBridgeRuleName = 'CentralEventBridgeRule'
    const centralEventBusName = 'CentralEventBus'

    // allow stack to have resources which use the manage policy: LambdaBasicExecutionPolicy
    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-IAM4', reason: 'Managed policy only permits Lambda function to write to CloudWatch.'
      }
    ])

    // Create new CloudTrail trail for management API Calls.
    const trailBucket = new StandardBucket(this, 'TrailBucket', {
      customerManagedEncryption: true, // customer can choose
      disableAccessLogging: false
    })
    new Trail(this, 'ManagementAPITrail', {
      bucket: trailBucket
    });

    // Event Bus
    const eventBus = new CfnEventBus(this, 'CentralEventBus', {
      name: centralEventBusName
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


    const snsTopicEncryptionKey = new Key(this, 'SNSTopicKey', {
      removalPolicy: RemovalPolicy.RETAIN,
      enableKeyRotation: true
    });
    snsTopicEncryptionKey.addToResourcePolicy(new PolicyStatement({
      actions: [
        'kms:Decrypt',
        'kms:GenerateDataKey*'
      ],
      effect: Effect.ALLOW,
      resources: [
        '*'
      ],
      principals: [new ServicePrincipal('events.amazonaws.com')],
    }))

    // Create SNS topic and Email subscription.
    const topic = new Topic(this, 'SNSTopic', {
      topicName: 'EventBridgeTopic',
      masterKey: snsTopicEncryptionKey
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
              resources: [
                `arn:aws:events:${this.region}:${this.account}:rule/${centralEventBusName}/${centralEventBridgeRuleName}`,
                `arn:aws:events:${this.region}:${this.account}:rule/${centralEventBridgeRuleName}`
              ]
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
        ManagedPolicy.fromManagedPolicyArn(this, 'LambdaBasic', 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole')
      ]
    })

    // Create Lambda function which creates EventBridge Rule with all member accounts.
    const updateRuleFunction = new Function(this, 'UpdateMatchingRuleLambda', {
      runtime: Runtime.NODEJS_14_X,
      handler: 'update-matching-rules-management.handler',
      timeout: cdk.Duration.minutes(10),
      environment: {
        REGION: process.env.REGION || '',
        ORGANIZATION_UNIT_ID: process.env.ORGANIZATION_UNIT_ID || '',
        SNS_TOPIC_ARN: topic.topicArn,
        EVENT_BUS_NAME: eventBus.name,
        CENTRAL_EVENT_BRIDGE_RULE_NAME: centralEventBridgeRuleName
      },
      role: updateMatchingruleLambdaRole,
      code: Code.fromAsset('lib/lambda'),
    })

    // configure custom resource based on Lambda.
    const customProviderUpdateMatchingRule = new Provider(this, 'UpdateMatchingRuleCustomProvider', {
      onEventHandler: updateRuleFunction,
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
