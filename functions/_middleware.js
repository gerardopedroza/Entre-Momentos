export async function onRequest(context) {
  const { request, next } = context;
  const response = await next();
  const contentType = response.headers.get("content-type") || "";

  if (!contentType.includes("text/html")) {
    return response;
  }

  const url = new URL(request.url);
  const origin = url.origin;
  const imageUrl = `${origin}/preview.jpg`;

  if (typeof HTMLRewriter !== "undefined") {
    return new HTMLRewriter()
      .on('meta[property="og:image"]', {
        element(e) {
          e.setAttribute("content", imageUrl);
        },
      })
      .on('meta[property="og:image:secure_url"]', {
        element(e) {
          e.setAttribute("content", imageUrl);
        },
      })
      .on('meta[name="twitter:image"]', {
        element(e) {
          e.setAttribute("content", imageUrl);
        },
      })
      .on('meta[property="og:url"]', {
        element(e) {
          e.setAttribute("content", url.href);
        },
      })
      .on('link[rel="image_src"]', {
        element(e) {
          e.setAttribute("href", imageUrl);
        },
      })
      .transform(response);
  }

  return response;
}
