export function createUrl(baseUrl: string, config: any) {
  const url = new URL(baseUrl);

  if (config) {
    const param =
      typeof window !== "undefined"
        ? btoa(JSON.stringify(config))
        : Buffer.from(JSON.stringify(config)).toString("base64");
    url.searchParams.set("config", param);
  }

  return url;
}
