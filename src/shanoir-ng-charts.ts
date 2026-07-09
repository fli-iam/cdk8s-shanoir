import { strict as assert } from "assert";
import { Construct } from "constructs";
import { Chart, Size } from "cdk8s";
import {
  ConfigMap, ContainerProps, ContainerRestartPolicy, Deployment, DeploymentProps,
  DeploymentStrategy, EnvFrom, EnvValue, Ingress, IngressBackend, INetworkPolicyPeer,
  IPersistentVolumeClaim, Job, JobProps, Namespace, NetworkPolicy, NetworkPolicyPort,
  NetworkPolicyProps, NetworkPolicyTrafficDefault, PersistentVolumeClaim, PodSecurityContextProps,
  RestartPolicy, Secret, Service, Volume, VolumeMount, Workload,

} from "cdk8s-plus-33"; import { quote } from "shell-quote"; import { URL } from "whatwg-url";

import {
  defaultDockerRepository, ShanoirDatabaseProps, ShanoirKeycloakProps, ShanoirNetworkPolicyFlow,
  ShanoirNetworkPolicyPeer, ShanoirNGProps, shanoirIngressDefaults, shanoirNGDefaults,
  shanoirMysqlDatabases, shanoirNetworkPoliciesDefaults, shanoirPostgresqlDatabases,
  shanoirSmtpDefaults, ShanoirSmtpProps, shanoirViewerMaxNumRequestsDefaults, shanoirVipDefaults,
  shanoirVolumes,

} from "./shanoir-ng-props";

//TODO: allocate resources (see #11)
const noResources = { resources: {} };

/** ensure that the `map` contains a set of expected keys
 *
 * If `map` is defined, then the function will:
 * - raise an exception if any key listed in `requiredKeys` is missing
 * - show a warning if the map includes a key not listed in `allKeys`
 *
 * If `knownKeys` is unset, then it is initialised with the value of `requiredKeys`.
 */
function checkResourceMap(desc: string, map: {[key: string]: unknown} | undefined,
                          requiredKeys: string[], knownKeys?: string[])
{
  if (map != undefined) {
    const actualSet = new Set(Object.keys(map));
    const requiredSet = new Set(requiredKeys);
    const knownSet = new Set(knownKeys ?? requiredKeys);
    const unknown = [...actualSet].filter(x => !knownSet.has(x));
    if (unknown.length) {
      console.error(`warning: unexpected ${desc}: ${unknown}`)
    }
    const missing = [...requiredSet].filter(x => !actualSet.has(x));
    if (missing.length) {
      throw `error: missing ${desc}: ${missing}`;
    }
  }
}

/** build a k8s EnvValue from string */
function envValue(value: string): EnvValue {
  return EnvValue.fromValue(value);
}

function httpUrlPort(url: URL): number {
  return parseInt(url.port || ((url.protocol == "http:") ? "80" : "443"));
}


export class ShanoirNGChart extends Chart
{
  readonly props: ShanoirNGProps;
  private readonly serviceSuffix: string;

  private readonly url: URL;
  private readonly viewerUrl: URL;

  private readonly flows: ShanoirNetworkPolicyFlow[];

  readonly commonConfigMap: ConfigMap;
  readonly secret: Secret;
  readonly smtpEnvVariables: {[key: string]: EnvValue};
  readonly vipEnvVariables: {[key: string]: EnvValue};
  readonly keycloakCredentialsEnvVariables: {[key: string]: EnvValue};
  readonly dcm4cheeDbEnvVariables: {[key: string]: EnvValue};

  readonly workloads: {[key: string]: Workload};
  readonly services: {[key: string]: Service};
  readonly volumes: {[key: string]: Volume};
  readonly volumeClaims: {[key: string]: IPersistentVolumeClaim};

  /** Additional chart for initialising a new shanoir instance from scratch
   *
   * This chart contains all the dangerous deployments and jobs that must never be run on an
   * existing instance (because they wipe out existing data).
   *
   * The name of this chart starts with 'danger-' to prevent accidental misuse.
   */
  readonly initChart?: Chart;

  constructor(scope: Construct, id: string, props: ShanoirNGProps)
  {
    ///////////////////////////////////////////////////////////////////
    // validate the user-provided props
    ///////////////////////////////////////////////////////////////////

    //console.error("orig props:", props);

    assert(props.keycloak.url == undefined); // not yet supported

    // keycloak internalUrl and peer cannot be used if keycloakUrl is unset
    assert(!(props.keycloak.url == undefined && props.keycloak.internalUrl != undefined));
    assert(!(props.keycloak.url == undefined && props.keycloak.peer != undefined));

    // must provide a smtp relay
    assert((props.smtp.host != undefined) || (props.smtp.mailpit != undefined));

    // optional deployments
    const useInternalKeycloak            = props.keycloak.url == undefined;
    const useInternalMysqlDatabases      = props.mysqlDatabases == undefined;
    const useInternalPostgresqlDatabases = props.postgresqlDatabases == undefined;
    const useMailpit                     = props.smtp.mailpit != undefined;

    // list of volumes for which we do not need a volume claim
    const optionalVolumes = new Set([
      "dcm4chee-arc-wildfly-data",
      "dcm4chee-ldap-data",
      "dcm4chee-sldap-data",
      ...(useInternalKeycloak             ? [] : ["keycloak-database-data"]),
      ...(useInternalMysqlDatabases       ? [] : ["keycloak-database-data", "database-data"]),
      ...(useInternalPostgresqlDatabases  ? [] : ["dcm4chee-database-data"]),
    ])

    // ensure all required volume claims and db credentials are provided 
    checkResourceMap("volume claim", props.volumeClaims,
                     shanoirVolumes.filter(x => !optionalVolumes.has(x)), shanoirVolumes);
    checkResourceMap("mysql database", props.mysqlDatabases, shanoirMysqlDatabases);
    checkResourceMap("postgresql database", props.postgresqlDatabases, shanoirPostgresqlDatabases);

    // ensure network policy flows reference at least one internal workload
    assert((props.networkPolicies?.extraFlows ?? []).every(
      (flow) => (typeof flow.src == "string") || typeof flow.dst == "string"));

    ///////////////////////////////////////////////////////////////////
    // initialise the object and build the final props
    ///////////////////////////////////////////////////////////////////

    props = {
      namespace: id,
      ...props,
      labels: {
        "app.kubernetes.io/name": "shanoir-ng",
        "app.kubernetes.io/instance": `${[...scope.node.scopes.slice(1), id].join("-")}`,
        "app.kubernetes.io/managed-by": "cdk8s-shanoir",
        ...props.labels,
      },
    };
    super(scope, id, props);
    this.serviceSuffix = `.${props.namespace}.svc.cluster.local`;
    this.services = {};
    this.workloads = {};
    this.flows = [];

    this.props = props = {
      // apply the defaults
      namespace: id,
      dockerRepository: defaultDockerRepository(props.version ?? shanoirNGDefaults.version),
      ...shanoirNGDefaults,
     
      // apply user-provided props
      ...props,

      // fill the child props objects
      ingress: {...shanoirIngressDefaults, ...props.ingress},
      keycloak: this.buildKeycloakProps(props.keycloak, props.url),
      mysqlDatabases: this.buildMysqlDatabasesProps(props.mysqlDatabases),
      networkPolicies: {...shanoirNetworkPoliciesDefaults, ...props.networkPolicies},
      postgresqlDatabases: this.buildPostgresqlDatabasesProps(props.postgresqlDatabases),
      smtp: this.buildSmtpProps(props.smtp),
      viewerMaxNumRequests: {...shanoirViewerMaxNumRequestsDefaults, ...props.viewerMaxNumRequests},
      vip:  {...shanoirVipDefaults,  ...props.vip },
    };

    //console.error("compiled props:", props);


    ///////////////////////////////////////////////////////////////////
    // create the cdk8s constructs
    ///////////////////////////////////////////////////////////////////

    if (props.init) {
      this.initChart = new Chart(scope, `danger-init-${id}`, props);
    }

    //////////// namespace ////////////

    if (props.createNamespace) {
      const ns = new Namespace(this, "ns", { metadata: { name: props.namespace }});
      // add dependency for existing services (services are lazily created by .getOrCreateService)
      Object.values(this.services).forEach((s) => s.node.addDependency(ns));
    }

    //////////// volumes ////////////

    // prepare the volume configs to be used in the containers
    this.volumeClaims = Object.fromEntries(Object.entries(this.props.volumeClaims).map(
      ([name, props]) => [name, new PersistentVolumeClaim(this, `pvc-${name}`, props)]));

    this.volumes = Object.fromEntries(Object.entries(this.volumeClaims).map(
      ([name, pvc]) => [name, Volume.fromPersistentVolumeClaim(this, `rv-${name}`, pvc)]));

    //////////// env vars ////////////

    // parse the urls and prepare the environment variables
    this.url = new URL(props.url);
    this.viewerUrl = new URL(props.viewerUrl);

    this.commonConfigMap = this.createCommonConfigMap();

    this.secret = this.createSecret();
    this.vipEnvVariables = this.createVipEnvVariables();
    this.keycloakCredentialsEnvVariables = this.createKeycloakCredentialsEnvVariables();
    this.dcm4cheeDbEnvVariables = this.createDcm4cheeDbEnvVariables();
    this.smtpEnvVariables = this.createSmtpEnvVariables();

    //////////// smtp service ////////////

    if (useMailpit) {
      this.deployMailpit();
    }

    //////////// backend services ////////////

    if (useInternalMysqlDatabases) {
      // deploy an internal mysql container
      this.deployMysqlDatabase("database");

      if (useInternalKeycloak) {
        this.deployMysqlDatabase("keycloak-database");
      }
    }

    this.deployRabbitmq();

    this.deploySolr();

    if (useInternalKeycloak) {
      this.deployKeycloak();
    }

    //////////// dcm4chee ////////////

    if (useInternalPostgresqlDatabases) {
      this.deployDcm4cheeDatabase();
    }

    this.deployDcm4chee();

    //////////// shanoir micro services ////////////

    this.deployMicroservices();

    //////////// front ////////////

    if (!this.props.init) {
      this.deployNginx();
    }

    this.createIngress();

    this.flows.push(...this.props.networkPolicies!.extraFlows!);
    this.createNetworkPolicies();
  }

  /** generate the OCI image name for a given shanoir service */
  shanoirImage(service: string): string
  {
    return `${this.props.dockerRepository}/${service}:${this.props.version}`;
  }

  /** get or create a service
   * 
   * This function allows lazily creating a service before its associated deployment is created.
   * This is needed to allow cyclic references.
   */
  getOrCreateService(name: string): Service
  {
    let svc = this.services[name];
    if (svc == undefined) {
      svc = this.services[name] = new Service(this, `svc-${name}`)
    }
    return svc
  }

  /** get the fully-qualified name of a service ("<SVC>.<NS>.svc.cluster.local")
   *
   * When `lazy` is unset, the function will fail if the service does not pre-exist in
   * `this.services` (otherwise it is lazily created).
   */
  serviceFqdn(name: string, lazy?: boolean): string 
  {
    let svc = lazy ? this.getOrCreateService(name) : this.services[name]!;
    return svc.resourceName! + this.serviceSuffix;
  }

  /** build the actual keycloak props (from the user-provided props) */
  buildKeycloakProps(keycloak: ShanoirKeycloakProps, shanoirUrl: string): ShanoirKeycloakProps
  {
    return (keycloak.url != undefined)
      // use an external user-provided keycloak server
      ? { internalUrl: keycloak.url, ...keycloak }

      // use the internal keycloak deployment
      : {
        ...keycloak,
        url: `${shanoirUrl}/auth`,
        internalUrl: `http://${this.serviceFqdn("keycloak", true)}:8080/auth`,
        peer: "keycloak",
      };
  }

  /** build the actual smtp props (from the user-provided props) */
  buildSmtpProps(smtp: ShanoirSmtpProps): ShanoirSmtpProps
  { 
    return (smtp.mailpit == undefined)
      // use an external smtp relay agent
      ? {...shanoirSmtpDefaults, ...smtp}

      // use the internal mailpit container
      : {
        ...shanoirSmtpDefaults, ...smtp,
        host: this.serviceFqdn("mailpit", true),
        peer: "mailpit",
        port: 1025,
        auth: undefined,
        starttls: "disabled",
      };
  }

  /** build the actual mysql db props (from the user-provided props) */
  private buildMysqlDatabasesProps(cfg?: {[key: string]: ShanoirDatabaseProps}):
    {[key: string]: ShanoirDatabaseProps}
  {
    return Object.fromEntries((cfg != undefined)
      // user-provided config: use external databases
      ? Object.entries(cfg).map(([db, props]) => [db, { port: 3306, ...props }])

      // no config provided: use internal mysql deployments
      : shanoirMysqlDatabases.map((db) => {
        const service = (db=="keycloak") ? "keycloak-database" : "database";
        return [db, {
          db:       db,
          username: db,
          password: "password",
          host: this.serviceFqdn(service, true),
          peer: service,
          port: 3306,
        }];
      }));
  }

  /** build the actual postgresql db props (from the user-provided props) */
  private buildPostgresqlDatabasesProps(cfg?: {[key: string]: ShanoirDatabaseProps}):
    {[key: string]: ShanoirDatabaseProps}
  {
    return Object.fromEntries((cfg != undefined)
      // user-provided config: use external databases
      ? Object.entries(cfg).map(([db, props]) => [db, { port: 5432, ...props }])
      
      // no config provided: use internal postgresql deployment
      : shanoirPostgresqlDatabases.map((db) => [db, {
        //FIXME should use same defaults as mysql dbs (these at the old defaults in docker-compose.yml)
        db:       "pacsdb",
        username: "pacs",
        password: "pacs",
        host: this.serviceFqdn("dcm4chee-database", true),
        peer: "dcm4chee-database",
        port: 5432,
      }]));
  }

  /** create a kubernetes secret with all passwords used in the chart  */
  private createSecret(): Secret
  {
    return new Secret(this, "sec", { stringData: {
      // create one entry for each database account ("users", "datasets", ...)
      ...Object.fromEntries([
        ...Object.entries(this.props.mysqlDatabases!),
        ...Object.entries(this.props.postgresqlDatabases!),
      ].map(([name, cred]) => [name, cred.password])),

      "keycloak-admin": this.props.keycloak.credentials.password,
      "vip-client-secret": this.props.vip!.clientSecret,
      "smtp": this.props.smtp.auth?.password ?? "-",
    }});
  }

  /** build a k8s EnvValue from an entry in this.secret */
  private secretEnvValue(key: string): EnvValue {
    return EnvValue.fromSecretValue({secret: this.secret, key: key})
  }

  /** common config map for all shanoir microservices */
  private createCommonConfigMap(): ConfigMap
  {
    assert(this.url.port == "");
    assert(this.url.pathname == "/");
    assert(this.viewerUrl.port == "")
    assert(this.viewerUrl.pathname == "/")

    return new ConfigMap(this, "cm-common", { data: {
      SHANOIR_PREFIX: "",
      SHANOIR_URL_SCHEME: this.url.protocol.replace(/:$/, ""),
      SHANOIR_URL_HOST: this.url.host,
      SHANOIR_VIEWER_OHIF_URL_SCHEME: this.viewerUrl.protocol.replace(/:$/, ""),
      SHANOIR_VIEWER_OHIF_URL_HOST: this.viewerUrl.host,
      SHANOIR_KEYCLOAK_URL: this.props.keycloak.url!,

      SHANOIR_ADMIN_EMAIL: this.props.adminEmail,
      SHANOIR_ADMIN_NAME: this.props.adminName,
      SHANOIR_INSTANCE_COLOR: this.props.instanceColor!,
      SHANOIR_INSTANCE_NAME: this.props.instanceName!,

      SHANOIR_KEYCLOAK_ADAPTER_MODE:  "check-sso",

      // NOTE: real deployments should always be exposed through an ingress service (which is
      // in charge of to setting the X-Forwarded-* headers)
      SHANOIR_X_FORWARDED: "trust",

      // NOTE: real deployments should always provide a CA-signed certificate
      SHANOIR_CERTIFICATE:            "manual",
      SHANOIR_CERTIFICATE_PEM_CRT:    "none",
      SHANOIR_CERTIFICATE_PEM_KEY:    "none",

      // NOTE: migrations should be be run in init-containers (regular containers should never apply
      // them automatically)
      SHANOIR_MIGRATION:              "never",
      }}); 
  }

  /** smtp environment variables needed for outgoing mail */
  private createSmtpEnvVariables(): { [key: string]: EnvValue }
  {
    return {
      SHANOIR_SMTP_HOST: envValue(this.props.smtp.host!),
      SHANOIR_SMTP_PORT: envValue(this.props.smtp.port!.toString()),
      SHANOIR_SMTP_AUTH: envValue((this.props.smtp.auth != undefined).toString()),
      SHANOIR_SMTP_USERNAME: envValue(this.props.smtp.auth?.username ?? "-"),
      SHANOIR_SMTP_STARTTLS_ENABLE: envValue((this.props.smtp.starttls != "disabled").toString()),
      SHANOIR_SMTP_STARTTLS_REQUIRED: envValue((this.props.smtp.starttls == "required").toString()),
      SHANOIR_SMTP_PASSWORD: this.secretEnvValue("smtp"),
      SHANOIR_SMTP_FROM: envValue(this.props.smtp.fromAddress),
    };
  }

  private createVipEnvVariables(): { [key: string]: EnvValue }
  {
    const url = new URL(this.props.vip!.url);
    assert(url.port == "");
    assert(url.pathname == "/");

    return {
      VIP_URL_SCHEME: envValue(url.protocol.replace(/:$/, "")),
      VIP_URL_HOST: envValue(url.host),
    };

  }

  private createKeycloakCredentialsEnvVariables(): { [key: string]: EnvValue }
  {
    return {
      SHANOIR_KEYCLOAK_USER: envValue(this.props.keycloak.credentials.username),
      SHANOIR_KEYCLOAK_PASSWORD: this.secretEnvValue("keycloak-admin"),
    };
  }

  private createDcm4cheeDbEnvVariables(): { [key: string]: EnvValue }
  {
    return{
      POSTGRES_DB:       envValue(this.props.postgresqlDatabases!["dcm4chee"]!.db),
      POSTGRES_USER:     envValue(this.props.postgresqlDatabases!["dcm4chee"]!.username),
      POSTGRES_PASSWORD: this.secretEnvValue("dcm4chee"),
    };
  }

  /** Generate a container that waits until multiple TCP servers are responding
   *
   * This is intended to be used as an init container when a pod requires these TCP servers to be up
   * before starting.
   */
  private waitTcpServers(servers: {host: string, port: number}[]): ContainerProps
  {
    return {
      name: "wait-tcp-servers",
      ...noResources,
      securityContext: this.securityContext("nobody"),
      image: "busybox",
      command: ["/bin/sh", "-c", `\
wait() {
  echo "\`date\` Waiting until TCP service $1:$2 is ready"
  while ! nc -w1 -- "$1" "$2" </dev/null >/dev/null ; do
    sleep 1
  done
}
${servers.map((s) => quote(['wait', s.host, s.port.toString()])).join("\n")}
echo "\`date\` done"
`],
    };
  }

  /** Add uid/gid parameters to a security context
   *
   * The resulting security context is created with the 'user', 'group' and 'fsGroup' initialised
   * with the uid listed in {@link ShanoirNGProps.uids}.
   */
  private securityContext(name: string, props?: PodSecurityContextProps): PodSecurityContextProps
  {
    const uid = this.props.uids![name]!;
    return {
        user: uid,
        group: uid,
        //FIXME: fsGroup may not have any effects at all
        //  - on ReadWriteMany pvcs
        //  - on hostpath volumes
        //https://github.com/kubernetes/website/issues/46688
        fsGroup: uid,
        //FIXME: should allow setting the policy to ALWAYS?
        //fsGroupChangePolicy: FsGroupChangePolicy.ON_ROOT_MISMATCH,
        ...(props ?? {}),
      }
  }

  /** common generic function for creating a deployment + an associated service
   *
   * @param scope  parent chart, should be `this` for regular deployments or `this.initChart` for
   *               initialisation deployments (which are dangerous)
   * @param name   base name of the deployment and service
   * @param ports  list of TCP ports included in the service
   * @param props  deployment properties (with 'replicas: 1' and 'strategy: "Recreate"' by
   *               default)
   *
   * 'props.securityContext' is processed through {@link this.securityContext}.
   *
   * The service is created only if `ports` is not empty and it is created with
   * {@link getOrCreateService} so that it can be referenced by prior objects.
   */
  private createDeployment(scope: Chart, name: string, ports: number[],
                           egressAllow: {dst?: string | INetworkPolicyPeer,
                                         ports: NetworkPolicyPort[]}[],
                           props: DeploymentProps): Deployment
  {
    assert(this.workloads[name] == undefined);
    
    egressAllow.forEach((flow) => this.flows.push({src: name, ...flow}));

    const deploy = this.workloads[name] = new Deployment(scope, `deploy-${name}`, {
      replicas: 1,
      strategy: DeploymentStrategy.recreate(),
      ...props,
      securityContext: this.securityContext(name, props.securityContext),
    });

    if (ports.length) {
      let svc = this.getOrCreateService(name);
      svc.select(deploy);
      ports.forEach((p) => svc.bind(p, {name: p.toString()}));
    }
    return deploy
  }

  /** common generic function for creating a job
   *
   * @param scope  parent chart, should be `this` for regular jobs or `this.initChart` for
   *               initialisation jobs (which are dangerous)
   * @param name   base name of the deployment and service
   * @param ports  list of TCP ports included in the service
   * @param props  job properties
   * @return       the created job
   *
   * 'props.securityContext' is processed through {@link this.securityContext}.
   */
  private createJob(scope: Chart, name: string,
                    egressAllow: {dst?: string | INetworkPolicyPeer,
                                  ports: NetworkPolicyPort[]}[],
                    props: JobProps): Job
  {
    assert(this.workloads[name] == undefined);

    egressAllow.forEach((flow) => this.flows.push({src: name, ...flow}));

    const job = this.workloads[name] = new Job(scope, `job-${name}`, {
      ...props,
      securityContext: this.securityContext(name, props.securityContext),
    });
    return job
   }


  private deployMailpit(): Deployment
  {
    return this.createDeployment(this, "mailpit", [1025, 8025], [], {
      containers: [{
        image: "axllent/mailpit",
        securityContext: { readOnlyRootFilesystem: false },
      }]
    });
  }

  private deployRabbitmq(): Deployment
  {
    return this.createDeployment(this, "rabbitmq", [5672], [], { containers: [{
      image: "rabbitmq:3.10.7",
      ...noResources,
      volumeMounts: [
        { path: "/var/lib/rabbitmq/mnesia", volume: this.volumes["rabbitmq-data"] },
        { path: "/var/log/rabbitmq", volume: this.volumes["logs"], subPath: "rabbitmq" },
      ],
    }]});
  }

  private deployMysqlDatabase(name: "database"|"keycloak-database"): Deployment
  {
      let opt = (name == "keycloak-database")
        ? {
          volumeName: "keycloak-database-data",
          extraEnv: {MARIADB_DATABASE: envValue("keycloak")},
          extraArgs: []
        } : {
          volumeName: "database-data",
          extraEnv: {} as {[key: string]: EnvValue},
          extraArgs: [ "--max_allowed_packet", "20000000"],
        };
      let tmp = Volume.fromEmptyDir(this, `${name}-tmp`, "tmp", { sizeLimit: Size.mebibytes(8) });

      return this.createDeployment(this, name, [3306], [], { 
        containers: [{
          image: this.shanoirImage(name),
          ...noResources,
          args: [
            // Fix k8s and old mysql
            // https://stackoverflow.com/questions/37644118/initializing-mysql-directory-error
            "--ignore-db-dir=lost+found",
            ...opt.extraArgs,
          ],
          envVariables: {
            MARIADB_ROOT_PASSWORD: envValue("password"),
            MARIADB_AUTO_UPGRADE: envValue("1"),
            ...opt.extraEnv,
          },
          volumeMounts: [
            { path: "/var/lib/mysql",       volume: this.volumes[opt.volumeName] },
            { path: "/tmp",                 volume: tmp, subPath: "tmp" },
            { path: "/var/lib/mysql-files", volume: tmp, subPath: "mysql-files" },
            { path: "/var/run/mysqld",      volume: tmp, subPath: "mysqld" },
          ],
        }],
      });
  }

  private deployKeycloak(): Deployment
  {
    const db = this.props.mysqlDatabases!["keycloak"]!;
    let tmp = Volume.fromEmptyDir(this, "keycloak-tmp", "tmp", { sizeLimit: Size.mebibytes(8) });

    let self = this;
    function kcContainer(overrideEnv: {[key: string]: EnvValue}): ContainerProps {
      return {
        image: self.shanoirImage("keycloak"),
        ...noResources,
        envFrom: [new EnvFrom(self.commonConfigMap)],
        envVariables: {
          ...self.keycloakCredentialsEnvVariables,
          ...self.smtpEnvVariables,
          KC_DB_URL_HOST: envValue(db.host),
          KC_DB_URL_PORT: envValue(db.port!.toString()),
          KC_DB_URL_DATABASE: envValue(db.db),
          KC_DB_USERNAME: envValue(db.username),
          KC_DB_PASSWORD: self.secretEnvValue("keycloak"),
          KC_HOSTNAME_DEBUG: envValue("true"),
          SHANOIR_ALLOWED_ADMIN_IPS: envValue(self.props.allowedAdminIps!.join(",")),
          SHANOIR_MIGRATION: envValue("never"),
          SHANOIR_USERS_HOST: envValue(self.serviceFqdn("ms", true)),
          ...overrideEnv,
        },
        volumeMounts: [
          { path: "/tmp", volume: tmp },
        ],
        securityContext: {
          // the image must be mounted in read-write mode because keycloak may rebuild the
          // executable on startup
          readOnlyRootFilesystem: false,
        }
      };
    }

    const egress = [
      {dst: db.peer,              ports: [NetworkPolicyPort.tcp(db.port!)]},
      {dst: this.props.smtp.peer, ports: [NetworkPolicyPort.tcp(this.props.smtp.port!)]},
      {dst: "ms",                 ports: [NetworkPolicyPort.tcp(9901)]},
    ];

    if (this.props.init) {
      return this.createDeployment(this.initChart!, "keycloak", [8080], egress, {
        // run keycloak in "init" mode (with the http server disabled to avoid detection by the
        // wait-tcp-servers init-container in the 'ms' deployment)
        initContainers: [kcContainer({
          SHANOIR_MIGRATION: envValue("init"),
          QUARKUS_HTTP_HOST_ENABLED: envValue("false"),
        })],
        // run keycloak normally after initialisation (needed by the 'users' container)
        containers: [kcContainer({})],
      });
    } else {
      return this.createDeployment(this, "keycloak", [8080], egress, {
        containers: [kcContainer({})]
      });
    }
  }

  private deploySolr(): Deployment
  {
    let tmp = Volume.fromEmptyDir(this, "solr-tmp", "tmp", { sizeLimit: Size.mebibytes(8) });

    return this.createDeployment(this, "solr", [8983], [], { containers: [{
      image: this.shanoirImage("solr"),
      ...noResources,
      envVariables: {
        SOLR_LOG_LEVEL: envValue("SEVERE"),
      },
      volumeMounts: [
        { path: "/var/solr", volume: this.volumes["solr-data"] },
        { path: "/tmp", volume: tmp },
      ],
    }]});
  }

  private deployDcm4cheeDatabase(): Deployment
  {
    let tmp = Volume.fromEmptyDir(this, `dcm4chee-database-tmp`, "tmp", { sizeLimit: Size.mebibytes(1) });

    return this.createDeployment(this, "dcm4chee-database", [5432], [], { containers: [{
      image: "dcm4che/postgres-dcm4chee:14.4-27",
      ...noResources,
      volumeMounts: [
        { path: "/var/lib/postgresql/data", volume: this.volumes["dcm4chee-database-data"] },
        { path: "/var/run/postgresql", volume:tmp, subPath: "run" },
        { path: "/tmp", volume:tmp, subPath: "tmp" },
      ],
      envVariables: this.dcm4cheeDbEnvVariables,
      securityContext: {
        // postgresql requires to be started as root because it chowns its datadir at startup
        // the server runs as uid 999
        ensureNonRoot: false,
      },
    }]});
  }

  private deployDcm4chee(): Deployment
  {
    const dcm4cheeDb = this.props.postgresqlDatabases!["dcm4chee"]!;
    let self = this;
    function optVolume(name: string, sizeMb: number): Volume {
      return self.volumes[name]
        ?? Volume.fromEmptyDir(self, name, name, {sizeLimit: Size.mebibytes(sizeMb)});
    }

    let deploy = this.createDeployment(this, "dcm4chee", [8081, 11112], [
      { dst: dcm4cheeDb.peer,  ports: [NetworkPolicyPort.tcp(dcm4cheeDb.port!)] }
    ], {
      // ldap sidecar container
      initContainers: [{
        name: "ldap",
        restartPolicy: ContainerRestartPolicy.ALWAYS,
        image: "dcm4che/slapd-dcm4chee:2.6.2-27.0",
        ...noResources,
        volumeMounts: [
          { path: "/var/lib/openldap/openldap-data", volume: optVolume("dcm4chee-ldap-data", 4) },
          { path: "/etc/openldap/slapd.d", volume: optVolume("dcm4chee-sldap-data", 4) },
        ],
        envVariables: {
          STORAGE_DIR: envValue("/storage/fs1"),
        },
        securityContext: {
          // slapd requires being started as root, with the rootfs in read-write mode because it
          // modifies the /etc/passwd on startup, ldap is run as uid 1021
          ensureNonRoot: false,
          readOnlyRootFilesystem: false,
        },
      }],
      // dcm4chee-arc app container
      containers: [{
        name: "dcm4chee-arc",
        image: "dcm4che/dcm4chee-arc-psql:5.27.0",
        ...noResources,
        volumeMounts: [
          { path: "/storage", volume: this.volumes["dcm4chee-arc-storage-data"] },
          { path: "/opt/wildfly/standalone", volume: optVolume("dcm4chee-arc-wildfly-data", 64) },
          { path: "/opt/wildfly/standalone/log", volume: this.volumes["dcm4chee-logs"] },
        ],
        envVariables: {
          ...this.dcm4cheeDbEnvVariables,
          HTTP_PORT: envValue("8081"),
          LDAP_URL: envValue(`ldap://127.0.0.1:389`),
          POSTGRES_HOST: envValue(dcm4cheeDb.host),
          POSTGRES_PORT: envValue(dcm4cheeDb.port!.toString()),
          WILDFLY_CHOWN: envValue("/storage /opt/wildfly/standalone/log"),
          WILDFLY_WAIT_FOR: envValue(`127.0.0.1:389 ${dcm4cheeDb.host}:${dcm4cheeDb.port}`),
        },
        securityContext: {
          // dcm4chee requires being started as root, because it chowns multiple diretories on
          // startup, wildfly runs as uid 1023
          ensureNonRoot: false,
          readOnlyRootFilesystem: false,
        },
      }],
    });

    // create a DNS alias "dcm4chee-arc" pointing to the actual dcm4chee service
    //
    // The datasets container uses the dcm4chee hostname in the urls stored in the dataset_file
    // table. Using a stable alias allows renaming the service without having to updating the whole
    // table (useful when snapshotting an instance).
    new Service(this, `cname-dcm4chee`, {
      metadata: { name: "dcm4chee-arc" },
      externalName: this.serviceFqdn("dcm4chee"),
    });

    return deploy;
  }

  /** Deploy the shanoir microservices */
  private deployMicroservices(): Deployment | undefined
  {
    const migrationsDb = this.props.mysqlDatabases!["migrations"];
    // TODO: https://github.com/fli-iam/shanoir-ng/issues/3430
    assert(migrationsDb.db=="migrations" &&
           migrationsDb.username=="migrations" &&
           migrationsDb.password=="password");

    let self=this;
    function shanoirContainer(name: string, hasDatabase: boolean,
                              props: {
                                envVariables?: { [key: string]: EnvValue },
                                extraVolumeMounts?: VolumeMount[],
                              }): ContainerProps
    {
      let dbVariables = {};
      if (hasDatabase) {
        const db = self.props.mysqlDatabases![name]!;
        dbVariables = {
          "SHANOIR_DB_HOST": envValue(db.host),
          "SHANOIR_DB_PORT": envValue(db.port!.toString()),
          "SHANOIR_DB_NAME": envValue(db.db),
          "spring.datasource.username": envValue(db.username),
          "spring.datasource.password": self.secretEnvValue(name),
        };
      }

      return {
          name: name,
          image: self.shanoirImage(name),
          ...noResources,
          envFrom: [ new EnvFrom(self.commonConfigMap), ],
          envVariables: {
            SHANOIR_MIGRATION: envValue(self.props.init! ? "init" : "never"),
            SHANOIR_KEYCLOAK_INTERNAL_URL: envValue(self.props.keycloak.internalUrl!),
            SHANOIR_STORAGE_TYPE: envValue("file-system"),
            "spring.rabbitmq.host": envValue(self.serviceFqdn("rabbitmq")),
            ...dbVariables,
            ...props.envVariables ?? {}},
          volumeMounts: [
            // NOTE: currently the studies, import, datasets, preclinical and nifti-conversion
            //       containers must share the same "/tmp" volume
            { path: "/tmp",                     volume: self.volumes["tmp"] },
            { path: "/var/log/shanoir-ng-logs", volume: self.volumes["logs"]! },
            ...(props.extraVolumeMounts ?? [])
          ],
          securityContext: self.securityContext("ms", {}),
      };
    }

    let shanoirProps = {
      initContainers: [
        this.waitTcpServers([
          { host: this.serviceFqdn("rabbitmq")!, port: 5672 },
          { host: migrationsDb.host, port: migrationsDb.port! },

          // The datasets container may rebuild the solr index on startup (this happens
          // automatically when the solr schema is updated or when the solar pvc is cleared)
          { host: this.serviceFqdn("solr")!, port: 8983 },

          // In 'init' mode the users container synchronises its user db with keycloak
          // (to populate the keycloak db with the initial users)
          ...((this.props.init! && this.services["keycloak"] != undefined)
              ? [{host: this.serviceFqdn("keycloak"), port: 8080 }] : []),
        ]),
        {
          name: "database-migrations",
          image: this.shanoirImage("database-migrations"),
          ...noResources,
          envVariables: {
            // TODO: support db/port/username/password
            MARIADB_HOST: envValue(migrationsDb.host),
            SHANOIR_MIGRATION: envValue(this.props.init! ? "init" : "manual"),
          },
        }
      ],
      containers: [
        shanoirContainer("users", true, {
          envVariables: {
            ...this.keycloakCredentialsEnvVariables,
            ...this.smtpEnvVariables,
            "VIP_SERVICE_EMAIL": envValue(this.props.vip!.serviceEmail),
          },
        }),
        shanoirContainer("studies", true, {
          extraVolumeMounts: [
            { path: "/var/studies-data", volume: this.volumes["studies-data"]! },
            { path: "/var/bids-data",    volume: this.volumes["bids-data"]! },
          ],
        }),

        shanoirContainer("import", true, {}),

        shanoirContainer("datasets", true, {
          envVariables: {
            SHANOIR_SHUTDOWN_HOUR:    envValue(`${this.props.shutdownHour}`),
            SHANOIR_CONTINUANCE_HOUR: envValue(`${this.props.continuanceHour}`),
            SHANOIR_SOLR_HOST: envValue(this.serviceFqdn("solr")),
            ...this.vipEnvVariables,
            VIP_CLIENT_SECRET: this.secretEnvValue("vip-client-secret"),
          },
          extraVolumeMounts: [
            { path: "/var/datasets-data", volume: this.volumes["datasets-data"] },
            { path: "/var/bids-data",     volume: this.volumes["bids-data"]! },
          ],
        }),

        shanoirContainer("preclinical", true, {
          extraVolumeMounts: [
            { path: "/var/preclinical-data", volume: this.volumes["preclinical-data"] },
          ],
        }),
    ]};

    const rabbitmqEgress = [
      {dst: "rabbitmq",                        ports: [NetworkPolicyPort.tcp(5672)]}, 
    ];
    const msEgress = [
      ...rabbitmqEgress,
      {dst: "dcm4chee",                        ports: [NetworkPolicyPort.tcp(8081)]},
      {dst: this.props.keycloak.peer,          ports: [NetworkPolicyPort.tcp(8080)]},
      {dst: "solr",                            ports: [NetworkPolicyPort.tcp(8983)]},
      {dst: migrationsDb.peer,                 ports: [NetworkPolicyPort.tcp(migrationsDb.port!)]},
      {dst: this.props.smtp.peer ?? "mailpit", ports: [NetworkPolicyPort.tcp(this.props.smtp.port!)]},
      {dst: this.props.vip!.peer, ports: [
        NetworkPolicyPort.tcp(httpUrlPort(new URL(this.props.vip!.url)))]},
    ];


    if (this.props.init!) {
      // initialisation mode
      this.createJob(this.initChart!, "ms", msEgress, {
        ...shanoirProps,
        restartPolicy: RestartPolicy.NEVER,
      });
      // bind a dummy port to the service (to avoid an exception due to lazy creation)
      this.services["ms"]!.bind(9900, { name: "dummy"})
      return undefined;

    } else {
      // normal mode
      this.createDeployment(this, "nifti-conversion", [], rabbitmqEgress, { containers: [
        shanoirContainer("nifti-conversion", false, {
          extraVolumeMounts: [
            { path: "/var/bids-data",     volume: this.volumes["bids-data"]! },
            { path: "/var/datasets-data", volume: this.volumes["datasets-data"]! },
          ],
        }),
      ]});
      this.createDeployment(this, "bids-validator", [], rabbitmqEgress, { containers: [{
        name: "bids-validator",
        image: self.shanoirImage("bids-validator"),
        ...noResources,
        envVariables : {
          AMQP_URL:  envValue(`amqp://guest:guest@${self.serviceFqdn("rabbitmq")}:5672/`),
          IN_QUEUE:  envValue("bids.validate"),
          OUT_QUEUE: envValue("bids.validated"),
          DATA_ROOT: envValue("/var/bids-data"),
        },
        volumeMounts: [
          { path: "/var/bids-data", volume: this.volumes["bids-data"]! },
        ],
        securityContext: self.securityContext("ms"),
      }]});

      return this.createDeployment(this, "ms", [9901, 9902, 9903, 9904, 9905], msEgress,
                                   shanoirProps);
    }
  }

  private deployNginx(): Deployment
  {
    return this.createDeployment(this, "nginx", [80], [
      {dst: "ms",       ports: [NetworkPolicyPort.tcpRange(9901, 9905)]},
      ...((this.services["keycloak"] != undefined)
          ? [{dst: "keycloak", ports: [NetworkPolicyPort.tcp(8080)]}] : []),
    ], { containers: [{
      image: this.shanoirImage("nginx"),
      ...noResources,
      volumeMounts: [
        { path: "/var/log/nginx", volume: this.volumes["logs"], subPath: "nginx" },
      ],
      envFrom: [ new EnvFrom(this.commonConfigMap)],
      envVariables: {
        ...this.vipEnvVariables,
        ...((this.services["keycloak"] != undefined)
            ? {SHANOIR_KEYCLOAK_HOST: envValue(this.serviceFqdn("keycloak"))} : {}),
        SHANOIR_USERS_HOST: envValue(this.serviceFqdn("ms")),
        SHANOIR_STUDIES_HOST: envValue(this.serviceFqdn("ms")),
        SHANOIR_IMPORT_HOST: envValue(this.serviceFqdn("ms")),
        SHANOIR_DATASETS_HOST: envValue(this.serviceFqdn("ms")),
        SHANOIR_PRECLINICAL_HOST: envValue(this.serviceFqdn("ms")),

        SHANOIR_VIEWER_OHIF_INTERACTION_NUM_REQUESTS:
          envValue(`${this.props.viewerMaxNumRequests!.interaction!}`),
        SHANOIR_VIEWER_OHIF_THUMBNAIL_NUM_REQUESTS:
          envValue(`${this.props.viewerMaxNumRequests!.thumbnail!}`),
        SHANOIR_VIEWER_OHIF_PREFETCH_NUM_REQUESTS:
          envValue(`${this.props.viewerMaxNumRequests!.prefetch!}`),
      },
      // FIXME: should not run as root
      securityContext: {
        ensureNonRoot: false,
        readOnlyRootFilesystem: false
      }
    }]});
  }

  private createIngress(): Ingress
  {
    let ingress = this.props.ingress;
    let tls = undefined;
    let rules = [];

    if (ingress.tlsCrt && ingress.tlsKey) {
      tls = [{
        hosts: [this.url.host, this.viewerUrl.host],
        secret: new Secret(this, "sec-tls", { stringData: {
          "tls.crt": ingress.tlsCrt,
          "tls.key": ingress.tlsKey,
        }})}];
    }

    if (this.services["nginx"] != undefined) {
      this.flows.push({src: ingress.peer, dst: "nginx", ports: [NetworkPolicyPort.tcp(80)]});

      let nginxBackend = IngressBackend.fromService(this.services["nginx"]!);
      rules.push({ host: this.url.host, backend: nginxBackend });
      rules.push({ host: this.viewerUrl.host, backend: nginxBackend });
    }

    if (this.services["keycloak"] != undefined && ingress.exposeKeycloakAdminConsole) { 
      this.flows.push({src: ingress.peer, dst: this.props.keycloak.peer!,
                       ports: [NetworkPolicyPort.tcp(8080)]});

      let keycloakBackend = IngressBackend.fromService(this.services["keycloak"]!);
      rules.push({ host: this.url.host, path: "/auth/admin/", backend: keycloakBackend});
      rules.push({ host: this.url.host, path: "/auth/realms/master/", backend: keycloakBackend});
      rules.push({ host: this.url.host, path: "/auth/resources/", backend: keycloakBackend});
    }

    if (this.props.smtp.mailpit?.host != undefined) {
      this.flows.push({src: ingress.peer, dst: "mailpit", ports: [NetworkPolicyPort.tcp(8025)]});

      rules.push({ host: this.props.smtp.mailpit!.host!,
                   backend: IngressBackend.fromService(this.services["mailpit"]!, { port: 8025 })});
    }

    return new Ingress(this, "ing", {
      className: ingress.className,
      metadata: {
        annotations: {
          // FIXME: shanoir should never return a http: url
          "nginx.ingress.kubernetes.io/proxy-redirect-from": `http://${this.url.host}`,
          "nginx.ingress.kubernetes.io/proxy-redirect-to":  `https://${this.url.host}`,
          // FIXME: this parameter should apply only to the endpoints which actually need it
          //        (eg: /shanoir-ng/import/importer/upload_dicom/)
          // FIXME: the nginx and datasets container have a similar parameter in their config
          //        -> we should have a key in this.props to configure all three at once
          "nginx.ingress.kubernetes.io/proxy-body-size": "5g",
        },
      },
      tls: tls,
      rules: rules,
    });
  }

  private createNetworkPolicies()
  {
    const ingressEnabled = this.props.networkPolicies!.ingress!;
    const egressEnabled  = this.props.networkPolicies!.egress!;
    if (!ingressEnabled && !egressEnabled) {
      return;
    }

    let netpols: {[key: string]: NetworkPolicyProps} = Object.fromEntries(
      Object.entries(this.workloads).map(([name, workload]) => [name, {
        selector: workload,
        ingress: ingressEnabled ? { default: NetworkPolicyTrafficDefault.DENY, rules: [] }
                                : undefined,
        egress: egressEnabled   ? { default: NetworkPolicyTrafficDefault.DENY,
                                    rules: [this.props.networkPolicies!.egressDnsRule!]}
                                : undefined,
      }]));

    let self = this;
    function resolve(peer?: ShanoirNetworkPolicyPeer): [ INetworkPolicyPeer | undefined,
                                                         NetworkPolicyProps | undefined, ]
    {
      return (typeof peer == "string") ? [self.workloads[peer], netpols[peer]]
                                       : [peer, undefined];
    }

    let error = false;
    for (const flow of this.flows) {
      let [srcPeer, srcPol] = resolve(flow.src);
      let [dstPeer, dstPol] = resolve(flow.dst);

      if (ingressEnabled && dstPol != undefined) {
        if (srcPeer==undefined) {
          console.error(`ERROR: undefined src peer: cannot create`+
                        ` ingress network policy rule for ${flow.src}->${flow.dst}`);
          error = true;
        } else {
          dstPol.ingress!.rules!.push({ peer: srcPeer, ports: flow.ports });
        }
      }
      if (egressEnabled && srcPol != undefined) {
        if (dstPeer==undefined) {
          console.error(`ERROR: undefined dst peer: cannot create`+
                        ` egress network policy rule for ${flow.src}->${flow.dst}`);
          error = true;
        } else {
          srcPol.egress!.rules!.push({ peer: dstPeer!, ports: flow.ports });
        }
      }
    }
    error;//assert(!error);

    for (const [name, netpol] of Object.entries(netpols)) {
      new NetworkPolicy(this, `netpol-${name}`, netpol)
    }
  }
}
