// Sign-out without Cloudflare's own "logged out" page.
//
// Any <a data-signout href="/cdn-cgi/access/logout"> is intercepted: the logout URL
// is called in the background (Access clears the cookie and revokes the session in
// every app), then the browser goes to the hub's signed-out page (gocontroll.tools).
// Copied from GOcontroll-Hours. Team's /pub/ is public, so its signed-out page loads
// without a session. Without JavaScript the plain link still signs out, it just lands on Cloudflare's page.
const SIGNED_OUT = 'https://gocontroll.tools/pub/signed-out';

document.addEventListener('click', async (event) => {
  const link = event.target.closest('a[data-signout]');
  if (!link) return;
  event.preventDefault();
  link.setAttribute('aria-busy', 'true');
  try {
    await fetch(link.href, { credentials: 'include', redirect: 'manual', cache: 'no-store' });
  } catch {
    // Network error: fall back to the plain logout link.
    window.location.href = link.href;
    return;
  }
  window.location.replace(SIGNED_OUT);
});
