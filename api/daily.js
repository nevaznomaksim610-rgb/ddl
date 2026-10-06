import { runCron } from '../src/serverless.js';
export default (req, res) => runCron(req, res, 'daily');
