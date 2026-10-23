// Sends visitors from the other Gosforth Skies addresses (gosforthskies.com, www, and the old astro.oneoffx.uk)
// to the main site at gosforthskies.co.uk, keeping the page they asked for. 301 = moved for good.
export default {
  fetch(req) {
    const u = new URL(req.url);
    return Response.redirect('https://gosforthskies.co.uk' + u.pathname + u.search, 301);
  },
};
