// CloudFront Function (viewer-request) — SPA routing without the asset trap.
//
// The distribution previously did SPA routing with CustomErrorResponses:
// 403 and 404 both answered with /index.html at HTTP 200. Custom error
// responses are distribution-wide and cannot be scoped to a path, so a request
// for a deleted bundle — say /assets/index-OLD.js, which the S3 sync removes
// on every frontend deploy — returned the HTML page with status 200. The
// browser then parsed HTML as JavaScript, and the failure surfaced as an
// unexplained runtime error rather than a plain 404.
//
// Instead: rewrite only extensionless paths to /index.html here, and drop the
// custom error responses. A missing asset then fails honestly, while a hard
// refresh on /products or /review still serves the app.
//
// The origin is S3 via OAC (REST, not the website endpoint), so a missing
// object returns 403 rather than 404 — that is expected and is now surfaced
// rather than masked.
function handler(event) {
  var request = event.request;
  var uri = request.uri;

  // Anything with a file extension is a real object: let it hit S3 and let a
  // miss be a miss. Checking the last segment, not the whole URI, so a path
  // like /docs/v1.2/settings is still treated as a route.
  var lastSegment = uri.slice(uri.lastIndexOf('/') + 1);
  if (lastSegment.indexOf('.') !== -1) {
    return request;
  }

  // Client-side route (including "/") — serve the app shell.
  request.uri = '/index.html';
  return request;
}
