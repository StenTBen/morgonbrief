/**
 * verify-firestore.mjs
 *
 * One job: prove that the service account in GCP_SERVICE_ACCOUNT can read the
 * feedback collection in Firestore. Nothing here is part of the brief - delete
 * the file and its workflow once the real feedback reader is in place.
 *
 * It checks four things in order, and tells you WHICH one failed, because the
 * failure modes look identical from the outside:
 *   1. the secret parses and names an account
 *   2. that account can mint a token
 *   3. Firestore answers at all (API enabled, project exists)
 *   4. the answer is data rather than a permission error
 *
 * Note on empty results: a collection with no documents returns {} and that is
 * a PASS. Read permission is proven by the absence of a 403, not by finding
 * rows.
 */

const COLLECTION = 'feedback';

function line() { console.log('─'.repeat(58)); }

let creds;
try {
  creds = JSON.parse(process.env.GCP_SERVICE_ACCOUNT ?? '');
} catch {
  console.error('FAIL (step 1): GCP_SERVICE_ACCOUNT is missing or is not valid JSON.');
  console.error('The secret must be the ENTIRE service-account JSON file pasted as one value,');
  console.error('starting with { and ending with }. A path or a fragment will not work.');
  process.exit(1);
}

const projectId = creds.project_id;
const clientEmail = creds.client_email;

line();
console.log('STEP 1  Secret parsed');
console.log(`  project_id   : ${projectId}`);
console.log(`  client_email : ${clientEmail}`);
console.log('');
console.log('  >> Compare client_email against the principal you granted');
console.log('     "Cloud Datastore Viewer" to in IAM. If they differ, the role');
console.log('     is on the wrong account and everything below will fail.');
line();

let token;
try {
  // Imported here rather than at the top so that a missing dependency reports
  // as a dependency problem instead of hiding the step 1 secret diagnostic.
  const { GoogleAuth } = await import('google-auth-library');
  const auth = new GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/cloud-platform']
  });
  const client = await auth.getClient();
  token = (await client.getAccessToken()).token;
  if (!token) throw new Error('no token returned');
} catch (e) {
  if (/Cannot find package|ERR_MODULE_NOT_FOUND/.test(e.message)) {
    console.error('FAIL: google-auth-library is not installed.');
    console.error('The npm install step did not run or did not finish. This is a workflow');
    console.error('problem, not an IAM or key problem.');
    process.exit(1);
  }
  console.error(`FAIL (step 2): could not mint an access token - ${e.message}`);
  console.error('The key itself is bad or has been disabled. Generate a new key for this');
  console.error('service account and replace the secret. This is not an IAM problem.');
  process.exit(1);
}
console.log('STEP 2  Access token minted');
line();

const url =
  `https://firestore.googleapis.com/v1/projects/${projectId}` +
  `/databases/(default)/documents/${COLLECTION}?pageSize=5`;

const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
const bodyText = await res.text();

console.log(`STEP 3  Firestore answered: HTTP ${res.status}`);
line();

if (res.status === 403) {
  console.error('FAIL (step 4): PERMISSION DENIED.');
  console.error('');
  console.error('Three causes, in order of likelihood:');
  console.error('  a) The role was granted to a different service account than the');
  console.error(`     one above (${clientEmail}).`);
  console.error('  b) The IAM change has not propagated yet. Wait two minutes, rerun.');
  console.error('  c) The Firestore API is not enabled on this project.');
  console.error('');
  console.error('Raw response:');
  console.error(bodyText.slice(0, 600));
  process.exit(1);
}

if (res.status === 404) {
  console.error('FAIL: project or database not found.');
  console.error(`Firestore has no "(default)" database in project ${projectId},`);
  console.error('or the project id in the secret is not the project holding your data.');
  console.error(bodyText.slice(0, 600));
  process.exit(1);
}

if (!res.ok) {
  console.error(`FAIL: unexpected status ${res.status}`);
  console.error(bodyText.slice(0, 600));
  process.exit(1);
}

const data = JSON.parse(bodyText);
const docs = data.documents ?? [];

console.log('PASS  Read permission is working.');
console.log('');
console.log(`  documents found in "${COLLECTION}": ${docs.length}`);

if (!docs.length) {
  console.log('');
  console.log('  Zero documents is still a PASS - permission was proven by the');
  console.log('  absence of a 403. But it means nothing has been written yet.');
  console.log('  Open the app, tap a feedback button on any entry, and rerun');
  console.log('  this to see an actual row come back.');
} else {
  console.log('');
  for (const d of docs) {
    const id = d.name.split('/').pop();
    const fields = Object.keys(d.fields ?? {}).join(', ');
    console.log(`  ${id}`);
    console.log(`    updated: ${d.updateTime}`);
    console.log(`    fields : ${fields || '(none)'}`);
  }
  console.log('');
  console.log('  >> Check that the fields above contain what the feedback loop will');
  console.log('     need: an entry id, a sphere, a vote value and a timestamp. If a');
  console.log('     sphere is missing, the complexity buttons cannot be scoped per');
  console.log('     area and that has to be fixed in the app before the loop is built.');
}
line();
