import serverlessHttp from 'serverless-http';
import { createRequestHandler } from './http-app.js';

// Wrap the Node.js HTTP handler for Lambda (Function URL / API Gateway v2)
export const handler = serverlessHttp(createRequestHandler());
