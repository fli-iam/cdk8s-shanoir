cdk8s constructs for shanoir-ng
===============================

**CAUTION: this is a work in progress (not ready for production)**


Example
-------

```ts
import { App } from 'cdk8s';
import { ShanoirNGChart, shanoirVolumes } from 'cdk8s-shanoir';

const app = new App();
new ShanoirNGChart(app, 'dummy', {
  url: "https://shanoir-dummy.localhost/",
  viewerUrl: "https://shanoir-dummy-viewer.localhost/",
  adminName: "Dummy Admin",
  adminEmail: "admin@shanoir-dummy.localhost",
  smtp: {
    host: "dummy-stmp.localhost",
    fromAddress: "no-reply@shanoir-dummy.localhost",
    auth: { username: "smtp-user", password: "stmp-pass" },
  },
  keycloakCredentials: { username: "admin", password: "qzflpuy;" },
  volumeClaimProps: Object.fromEntries(shanoirVolumes.map((name) => [name, {}])),
});
app.synth();
```
