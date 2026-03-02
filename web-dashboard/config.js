/**
 * web-dashboard/config.js
 * Admin-editable configuration for the MeetRecord web dashboard.
 * Edit this file before deploying the dashboard to your hosting environment.
 */

export const CONFIG = {
  // AWS region (e.g. 'us-east-1')
  AWS_REGION: '',

  // Cognito User Pool App Client ID
  COGNITO_CLIENT_ID: '',

  // Cognito User Pool ID (e.g. 'us-east-1_xxxxxxxx')
  COGNITO_USER_POOL_ID: '',

  // Cognito Identity Pool ID (e.g. 'us-east-1:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx')
  COGNITO_IDENTITY_POOL_ID: '',

  // S3 bucket name (same bucket the extension uploads to)
  S3_BUCKET: '',
};
