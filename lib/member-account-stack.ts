import * as cdk from '@aws-cdk/core';
import { IRule, Rule, RuleTargetConfig } from '@aws-cdk/aws-events';
import { Effect, PolicyStatement, Role, ServicePrincipal } from '@aws-cdk/aws-iam';
import { ComparisonOperator, Metric, Statistic } from '@aws-cdk/aws-cloudwatch';
import { CfnParameter } from '@aws-cdk/core';

export class AwsOrganizationsEventBridgeSetupMemberStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const eventBusName = new CfnParameter(this, "eventBusName", {
      type: "String",
      description: "Management Account event bus name."
    });

    const publishingRole = new Role(this, "PublishingRole", {
      assumedBy: new ServicePrincipal('events.amazonaws.com')
    });
    publishingRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        resources: [`arn:aws:events:${process.env.REGION}:${process.env.CDK_MANAGEMENT_ACCOUNT}:event-bus/${eventBusName.valueAsString}`],
        actions: [
          "events:PutEvents"
        ]
      })
    );

    const rule = {
      name: 'MemberEventBridgeRule',
      sources: ['aws.cloudwatch', 'aws.config', 'aws.guardduty'],
      description: 'The Rule propagates all Amazon CloudWatch Events, AWS Config Events, AWS Guardduty Events to the management account'
    };

    const cdkRule = new Rule(this, rule.name, {
      description: rule.description,
      ruleName: rule.name,
      eventPattern: {
        source: rule.sources,
      }
    });
    cdkRule.addTarget({
      bind(_rule: IRule, generatedTargetId: string): RuleTargetConfig {
        return {
          arn: `arn:aws:events:${process.env.REGION}:${process.env.CDK_MANAGEMENT_ACCOUNT}:event-bus/${eventBusName.valueAsString}`,
          id: generatedTargetId,
          role: publishingRole
        };
      }
    });

    // Create a CloudWatch alarm only for testing purposes.
    const metric = new Metric({
      namespace: 'AWS/Billing',
      metricName: 'EstimatedCharges',
      statistic: Statistic.MAXIMUM,
    });
    metric.createAlarm(this, 'Alarm', {
      alarmName: 'BillingAlarm',
      threshold: 10,
      evaluationPeriods: 5,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      actionsEnabled: false
    });
  }
}
