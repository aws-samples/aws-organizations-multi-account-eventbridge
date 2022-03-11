import { Construct, RemovalPolicy } from '@aws-cdk/core';
import { Key } from '@aws-cdk/aws-kms';
import { Bucket, BucketProps, BucketEncryption, IBucket, BlockPublicAccess } from '@aws-cdk/aws-s3';
import { AccountRootPrincipal, AnyPrincipal, Effect, PolicyDocument, PolicyStatement, ServicePrincipal } from '@aws-cdk/aws-iam';
import { NagSuppressions } from 'cdk-nag';

export interface StandardBucketProps extends BucketProps {
  customerManagedEncryption: boolean;
  disableAccessLogging?: boolean;
}

export class StandardBucket extends Bucket implements IBucket {
  constructor(scope: Construct, id: string, props?: StandardBucketProps) {
    const config = { ...props };

    // encryption
    if (config.customerManagedEncryption) {
      config.encryption = BucketEncryption.KMS;
      config.encryptionKey = new Key(scope, `${id}Key`, {
        alias: id,
        removalPolicy: RemovalPolicy.RETAIN,
        enableKeyRotation: true,
        policy: new PolicyDocument({
          statements: [
            new PolicyStatement({
              actions: [
                'kms:GenerateDataKey',
                'kms:DescribeKey'
              ],
              effect: Effect.ALLOW,
              principals: [
                new ServicePrincipal('cloudtrail.amazonaws.com')
              ],
              resources: ['*']
            }),
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: [
                'kms:*'
              ],
              resources: ['*'],
              principals: [
                new AccountRootPrincipal()
              ]
            })
          ]
        })
      });
    } else {
      config.encryption = BucketEncryption.S3_MANAGED;
    }

    // enable access logging
    if (!config.disableAccessLogging) {
      config.serverAccessLogsBucket = new StandardBucket(scope, `${id}AccessBucket`, {
        ...config,
        customerManagedEncryption: false,
        disableAccessLogging: true,
        encryptionKey: undefined
      });

      NagSuppressions.addResourceSuppressions(config.serverAccessLogsBucket, [
        {
          id: 'AwsSolutions-S1', reason: 'The server access log bucket cannot have its own server access log bucket'
        }
      ]);
    }


    config.removalPolicy = config.removalPolicy ?? RemovalPolicy.RETAIN;
    config.versioned = false;
    config.publicReadAccess = false;
    config.blockPublicAccess = BlockPublicAccess.BLOCK_ALL;

    super(scope, id, config as BucketProps);
    this.addToResourcePolicy(new PolicyStatement({
      actions: [
        's3:*'
      ],
      effect: Effect.DENY,
      resources: [
        this.bucketArn,
        `${this.bucketArn}/*`
      ],
      conditions: {
        Bool: {
          'aws:SecureTransport': false
        }
      },
      principals: [
        new AnyPrincipal()
      ]
    }));
  }
}