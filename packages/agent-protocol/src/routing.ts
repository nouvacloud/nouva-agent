export interface LocalHttpRoute {
  fileKey: string;
  hostnames: string[];
  serviceUrl: string;
}

function quoteHostnames(hostnames: string[]): string {
  return hostnames.map((hostname) => `Host(\`${hostname}\`)`).join(" || ");
}

function serializeYaml(lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

export function buildLocalHttpRouteConfig(route: LocalHttpRoute): string {
  const routerName = `http-${route.fileKey}`;
  const serviceName = `svc-${route.fileKey}`;

  return serializeYaml([
    "http:",
    "  routers:",
    `    ${routerName}:`,
    `      rule: "${quoteHostnames(route.hostnames)}"`,
    "      entryPoints:",
    "        - web",
    `      service: ${serviceName}`,
    "  services:",
    `    ${serviceName}:`,
    "      loadBalancer:",
    "        passHostHeader: true",
    "        servers:",
    `          - url: ${route.serviceUrl}`,
  ]);
}
