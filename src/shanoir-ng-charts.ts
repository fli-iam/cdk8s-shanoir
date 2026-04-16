import { strict as assert } from "assert";
import { Construct } from "constructs";
import { Chart, Size } from "cdk8s";
import {
  ConfigMap, ContainerProps, ContainerRestartPolicy, Deployment, DeploymentProps,
  DeploymentStrategy, EnvFrom, EnvValue, Ingress, IngressBackend, IPersistentVolumeClaim, Job,
  JobProps, Namespace, PersistentVolumeClaim, PodSecurityContextProps, RestartPolicy, Secret,
  Service, Volume, VolumeMount,

} from "cdk8s-plus-33"; import { URL } from "whatwg-url";

import {
  ShanoirDatabaseProps, ShanoirNGProps, shanoirNGDefaults, shanoirMysqlDatabases,
  shanoirPostgresqlDatabases, shanoirSmtpDefaults, shanoirVipDefaults, shanoirVolumes,
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

export class ShanoirNGChart extends Chart
{
  readonly props: ShanoirNGProps;

  private readonly url: URL;
  private readonly viewerUrl: URL;

  readonly commonConfigMap: ConfigMap;
  readonly secret: Secret;
  readonly smtpEnvVariables: {[key: string]: EnvValue};
  readonly vipEnvVariables: {[key: string]: EnvValue};
  readonly keycloakCredentialsEnvVariables: {[key: string]: EnvValue};
  readonly dcm4cheeDbEnvVariables: {[key: string]: EnvValue};

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
    //console.error("orig props:", props);

    assert(props.keycloakUrl == undefined); // not yet supported

    // keycloakInternalUrl cannot be used if keycloakUrl is unset
    assert(!(props.keycloakInternalUrl != undefined && props.keycloakUrl == undefined));

    // must provide a smtp relay
    assert((props.smtp.host != undefined) || (props.smtp.mailpit != undefined));

    // optional features
    const useInternalKeycloak            = props.keycloakUrl == undefined;
    const useInternalMysqlDatabases      = props.mysqlDatabases == undefined;
    const useInternalPostgresqlDatabases = props.postgresqlDatabases == undefined;

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


    // apply the defaults
    // (after this line, all keys of `props`, `props.smtp` and `props.vip` are defined)
    props = {
      namespace: id,
      keycloakUrl: `${props.url}/auth`,
      keycloakInternalUrl: props.keycloakUrl,
      ...shanoirNGDefaults, ...props,
      smtp: {...shanoirSmtpDefaults, ...props.smtp },
      vip:  {...shanoirVipDefaults,  ...props.vip },
    };
    //console.error("compiled props:", props);

    super(scope, id, props);
    this.props = props;
    this.services = {};

    if (props.init) {
      this.initChart = new Chart(scope, `danger-init-${id}`, props);
    }

    //////////// namespace ////////////

    if (props.createNamespace) {
      new Namespace(this, "ns", { metadata: { name: props.namespace }});
    }

    //////////// volumes ////////////

    // prepare the volume configs to be used in the containers
    this.volumeClaims = Object.fromEntries(Object.entries(this.props.volumeClaims).map(
      ([name, props]) => [name, new PersistentVolumeClaim(this, `${name}-pvc`, props)]));

    this.volumes = Object.fromEntries(Object.entries(this.volumeClaims).map(
      ([name, pvc]) => [name, Volume.fromPersistentVolumeClaim(this, `${name}-rv`, pvc)]));

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

    if (props.smtp.mailpit != undefined) {
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

    this.deployShanoir();

    //////////// front ////////////

    if (!this.props.init) {
      this.deployNginx();
    }

    this.createIngress();
  }

  /** generate the OCI image name for a given shanoir service */
  shanoirImage(service: string): string
  {
    return `${this.props.dockerRepository}/${service}:${this.props.version}`;
  }

  /** get or create a service
   * 
   * This function allows lazily creating a service before its associated deployment is created.
   * This is needed to allow cross-references between.
   */
  getOrCreateService(name: string): Service
  {
    let svc = this.services[name];
    if (svc == undefined) {
      svc = this.services[name] = new Service(this, `${name}-svc`)
    }
    return svc
  }

  /** get the actual name of a service (i.e. the name of the api object)
   *
   * When `lazy` is unset, the function will fail if the service does not pre-exist in
   * `this.services` (otherwise it is lazily created).
   */
  serviceName(name: string, lazy?: boolean): string 
  {
    let svc = lazy ? this.getOrCreateService(name) : this.services[name]!;
    return svc.resourceName!;
  }

  /** get the internal url of the keycloak service */
  keycloakInternalUrl(): string
  {
    return this.props.keycloakInternalUrl ??
      `http://${this.serviceName("keycloak")}:8080/auth`;
  }

  /** get the actual parameters for a given mysql database
   *
   * - resolve `host` to the internal database service if used
   * - set default `port` value
   */
  mysqlDatabase(name: string): ShanoirDatabaseProps {
    const db = this.props.mysqlDatabases![name]!;
    return {...db,
      host: ((db.host != "INTERNAL") ? db.host : 
             (name == "keycloak") ? this.serviceName("keycloak-database") :
             this.serviceName("database")),
      port: db.port ?? 3306,
    };
  }

  /** get the actual parameters for a given postgresql database
   *
   * - resolve `host` to the internal database service if used
   * - set default `port` value
   */
  postgresqlDatabase(name: string): ShanoirDatabaseProps {
    const db = this.props.postgresqlDatabases![name]!;
    return {...db,
      host: ((db.host!="INTERNAL") ? db.host : this.serviceName("dcm4chee-database")),
      port: db.port ?? 5432,
    };
  }

  createVolumeClaims(): {[key: string]: IPersistentVolumeClaim}
  {
    return Object.fromEntries(Object.entries(this.props.volumeClaims).map(
      ([name, props]) => [name, new PersistentVolumeClaim(this, `${name}-pvc`, props)]
    ));
  }
  createVolumes(): {[key: string]: Volume}
  {
    return Object.fromEntries(Object.entries(this.volumeClaims).map(
      ([name, pvc]) => [name, Volume.fromPersistentVolumeClaim(this, `${name}-rv`, pvc)]));
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

      "keycloak-admin": this.props.keycloakCredentials.password,
      "vip-client-secret": this.props.vip!.clientSecret,
      "smtp": this.props.smtp.auth?.password ?? "-",
    }});
  }

  /** build a k8s EnvValue from an entry in this.secret */
  private secretEnvValue(key: string): EnvValue {
    return EnvValue.fromSecretValue({secret: this.secret, key: key})
  }

  /** common config map for all shanoir microservices */
  createCommonConfigMap(): ConfigMap
  {
    assert(this.url.port == "");
    assert(this.url.pathname == "/");
    assert(this.viewerUrl.port == "")
    assert(this.viewerUrl.pathname == "/")

    return new ConfigMap(this, "common-cm", { data: {
      SHANOIR_PREFIX: "",
      SHANOIR_URL_SCHEME: this.url.protocol.replace(/:$/, ""),
      SHANOIR_URL_HOST: this.url.host,
      SHANOIR_VIEWER_OHIF_URL_SCHEME: this.viewerUrl.protocol.replace(/:$/, ""),
      SHANOIR_VIEWER_OHIF_URL_HOST: this.viewerUrl.host,
      SHANOIR_KEYCLOAK_URL: this.props.keycloakUrl!,

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
    const commonVars = {
      SHANOIR_SMTP_FROM: envValue(this.props.smtp.fromAddress),
    };

    if (this.props.smtp.host == undefined) {
      // development setup: use the mailpit service
      return {
        SHANOIR_SMTP_HOST: envValue(this.serviceName("mailpit", true)),
        SHANOIR_SMTP_PORT: envValue("1025"),
        SHANOIR_SMTP_AUTH: envValue("false"),
        SHANOIR_SMTP_USERNAME: envValue("-"),
        SHANOIR_SMTP_PASSWORD: envValue("-"),
        SHANOIR_SMTP_STARTTLS_ENABLE: envValue("false"),
        ...commonVars
      };
    } else {
      // normal setup: use an external SMTP relay
      return {
        SHANOIR_SMTP_HOST: envValue(this.props.smtp.host),
        SHANOIR_SMTP_PORT: envValue(this.props.smtp.port!.toString()),
        SHANOIR_SMTP_AUTH: envValue((this.props.smtp.auth != undefined).toString()),
        SHANOIR_SMTP_USERNAME: envValue(this.props.smtp.auth?.username ?? "-"),
        SHANOIR_SMTP_STARTTLS_ENABLE: envValue((this.props.smtp.starttls != "disabled").toString()),
        SHANOIR_SMTP_STARTTLS_REQUIRED: envValue((this.props.smtp.starttls == "required").toString()),
        SHANOIR_SMTP_PASSWORD: this.secretEnvValue("smtp"),
        ...commonVars
      };
    }
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
      SHANOIR_KEYCLOAK_USER: envValue(this.props.keycloakCredentials.username),
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
                           props: DeploymentProps): Deployment
  {
    const deploy = new Deployment(scope, `${name}-deploy`, {
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
  private createJob(scope: Chart, name: string, props: JobProps): Job
  {
    return new Job(scope, `${name}-job`, {
      ...props,
      securityContext: this.securityContext(name, props.securityContext),
    });
  }

  private deployMailpit(): Deployment
  {
    return this.createDeployment(this, "mailpit", [1025, 8025], {
      containers: [{
        image: "axllent/mailpit",
        securityContext: { readOnlyRootFilesystem: false },
      }]
    });
  }

  private deployRabbitmq(): Deployment
  {
    return this.createDeployment(this, "rabbitmq", [5672], { containers: [{
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
          extraEnv: {MYSQL_DATABASE: envValue("keycloak")},
          extraArgs: []
        } : {
          volumeName: "database-data",
          extraEnv: {} as {[key: string]: EnvValue},
          extraArgs: [ "--max_allowed_packet", "20000000"],
        };
      let tmp = Volume.fromEmptyDir(this, `${name}-tmp`, "tmp", { sizeLimit: Size.mebibytes(8) });

      return this.createDeployment(this, name, [3306], { 
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
            "MYSQL_ROOT_PASSWORD": envValue("password"),
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
    const db = this.mysqlDatabase("keycloak")!;
    let tmp = Volume.fromEmptyDir(this, "keycloak-tmp", "tmp", { sizeLimit: Size.mebibytes(8) });

    let self = this;
    function kcContainer(migration: string): ContainerProps {
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
          SHANOIR_MIGRATION: envValue(migration),
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

    if (this.props.init) {
      return this.createDeployment(this.initChart!, "keycloak", [8080], {
        initContainers: [kcContainer("init")],
        // run keycloak normally after initialisation (needed by the 'users' container)
        containers: [kcContainer("never")],
      });
    } else {
      return this.createDeployment(this, "keycloak", [8080], {
      containers: [kcContainer("never")]
      });
    }
  }

  private deploySolr(): Deployment
  {
    let tmp = Volume.fromEmptyDir(this, "solr-tmp", "tmp", { sizeLimit: Size.mebibytes(8) });

    return this.createDeployment(this, "solr", [8983], { containers: [{
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

    return this.createDeployment(this, "dcm4chee-database", [5432], { containers: [{
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
    const dcm4cheeDb = this.postgresqlDatabase("dcm4chee");
    let self = this;
    function optVolume(name: string, sizeMb: number): Volume {
      return self.volumes[name]
        ?? Volume.fromEmptyDir(self, name, name, {sizeLimit: Size.mebibytes(sizeMb)});
    }

    let deploy = this.createDeployment(this, "dcm4chee", [8081, 11112], {
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
    new Service(this, `dcm4chee-cname`, {
      metadata: { name: "dcm4chee-arc" },
      externalName: `${this.serviceName("dcm4chee")}.${self.props.namespace}.svc.cluster.local`,
    });

    return deploy;
  }

  private deployShanoir(): Deployment | undefined
  {
    const migrationsDb = this.mysqlDatabase("migrations");
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
        const db = self.mysqlDatabase(name);
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
            SHANOIR_KEYCLOAK_INTERNAL_URL: envValue(self.keycloakInternalUrl()),
            "spring.rabbitmq.host": envValue(self.serviceName("rabbitmq")),
            ...dbVariables,
            ...props.envVariables ?? {}},
          volumeMounts: [
            // NOTE: currently the studies, import, datasets, preclinical and nifti-conversion
            //       containers must share the same "/tmp" volume
            { path: "/tmp",                     volume: self.volumes["tmp"] },
            { path: "/var/log/shanoir-ng-logs", volume: self.volumes["logs"]! },
            ...(props.extraVolumeMounts ?? [])
          ],
          securityContext: self.securityContext("shanoir", {}),
      };
    }

    let shanoirProps = {
      initContainers: [ {
          name: "database-migrations",
          image: this.shanoirImage("database-migrations"),
          ...noResources,
          envVariables: {
            // TODO: support db/port/username/password
            MYSQL_HOST: envValue(migrationsDb.host),
            SHANOIR_MIGRATION: envValue(this.props.init! ? "init" : "manual"),
          },
        }
      ],
      containers: [
        shanoirContainer("users", true, {
          envVariables: {
            ...this.keycloakCredentialsEnvVariables,
            ...this.smtpEnvVariables,
            "kc.admin.client.server.url": envValue(
              `http://${this.serviceName("keycloak")}:8080/auth`),
            "VIP_SERVICE_EMAIL": envValue(this.props.vip!.serviceEmail),
          },
        }),
        shanoirContainer("studies", true, {
          extraVolumeMounts: [
            { path: "/var/studies-data", volume: this.volumes["studies-data"]! },
            // This is related to participants.tsv file
            { path: "/var/datasets-data", volume: this.volumes["datasets-data"]! },
          ],
        }),

        shanoirContainer("import", true, {}),

        shanoirContainer("datasets", true, {
          envVariables: {
            SHANOIR_SOLR_HOST: envValue(this.serviceName("solr")),
            ...this.vipEnvVariables,
            VIP_CLIENT_SECRET: this.secretEnvValue("vip-client-secret"),
          },
          extraVolumeMounts: [
            { path: "/var/datasets-data", volume: this.volumes["datasets-data"] },
          ],
        }),

        shanoirContainer("preclinical", true, {
          extraVolumeMounts: [
            { path: "/var/extra-data", volume: this.volumes["extra-data"] },
          ],
        }),
    ]};

    if (this.props.init!) {
      // initialisation mode
      this.createJob(this.initChart!, "shanoir", {
        ...shanoirProps,
        restartPolicy: RestartPolicy.NEVER,
      });
      // bind a dummy port to the service (to avoid an exception due to lazy creation)
      this.services["ms"]!.bind(9900, { name: "dummy"})
      return undefined;

    } else {
      // normal mode
      this.createDeployment(this, "nifti-conversion", [], { containers: [
        shanoirContainer("nifti-conversion", false, {
          extraVolumeMounts: [
            { path: "/var/datasets-data", volume: this.volumes["datasets-data"]! },
          ],
        }),
      ]});

      return this.createDeployment(this, "shanoir", [9901, 9902, 9903, 9904, 9905], shanoirProps);
    }
  }

  private deployNginx(): Deployment
  {
    return this.createDeployment(this, "nginx", [80], { containers: [{
      image: this.shanoirImage("nginx"),
      ...noResources,
      volumeMounts: [
        { path: "/var/log/nginx", volume: this.volumes["logs"], subPath: "nginx" },
      ],
      envFrom: [ new EnvFrom(this.commonConfigMap)],
      envVariables: {
        ...this.vipEnvVariables,
        // FIXME: will fail if using an external keycloak server
        SHANOIR_KEYCLOAK_HOST: envValue(this.serviceName("keycloak")),
        SHANOIR_USERS_HOST: envValue(this.serviceName("shanoir")),
        SHANOIR_STUDIES_HOST: envValue(this.serviceName("shanoir")),
        SHANOIR_IMPORT_HOST: envValue(this.serviceName("shanoir")),
        SHANOIR_DATASETS_HOST: envValue(this.serviceName("shanoir")),
        SHANOIR_PRECLINICAL_HOST: envValue(this.serviceName("shanoir")),
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
        secret: new Secret(this, "tls-sec", { stringData: {
          "tls.crt": ingress.tlsCrt,
          "tls.key": ingress.tlsKey,
        }})}];
    }

    if (this.services["nginx"] != undefined) {
      let nginxBackend = IngressBackend.fromService(this.services["nginx"]!);
      rules.push({ host: this.url.host, backend: nginxBackend });
      rules.push({ host: this.viewerUrl.host, backend: nginxBackend });
    }

    if (this.services["keycloak"] != undefined && ingress.exposeKeycloakAdminConsole) { 
      let keycloakBackend = IngressBackend.fromService(this.services["keycloak"]!);
      rules.push({ host: this.url.host, path: "/auth/admin/", backend: keycloakBackend});
      rules.push({ host: this.url.host, path: "/auth/realms/master/", backend: keycloakBackend});
    }

    if (this.props.smtp.mailpit?.host != undefined) {
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
}
