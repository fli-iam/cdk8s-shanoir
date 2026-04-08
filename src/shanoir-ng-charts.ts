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

/** ensure that the `map` contains all keys listed in `expect`
 *
 * - raise an exception if a key is missing
 * - show a warning if an extra key is present
 */
function checkResourceMap(desc: string, map: {[key: string]: unknown} | undefined, expect: string[])
{
  if (map != undefined) {
    const actualSet = new Set(Object.keys(map));
    const expectSet = new Set(expect);
    const unknown = [...actualSet].filter(x => !expectSet.has(x));
    if (unknown.length) {
      console.error(`warning: unknown ${desc}: ${unknown}`)
    }
    const missing = [...expectSet].filter(x => !actualSet.has(x));
    if (missing.length) {
      throw `error: missing ${desc}: ${missing}`;
    }
  }
}

/** build a k8s EnvValue from string */
function envValue(value: string): EnvValue {
  return EnvValue.fromValue(value);
}

type OptService<T> = T extends undefined ? undefined : Service;

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

  readonly volumes: {[key: string]: Volume};
  readonly volumeClaims: {[key: string]: IPersistentVolumeClaim};
  readonly dcm4cheeService: Service;
  readonly keycloakService?: Service;
  readonly keycloakMysqlService?: Service;
  readonly mysqlService?: Service;
  readonly nginxService?: Service;
  readonly postgresqlService?: Service;
  readonly rabbitmqService: Service;
  readonly shanoirService?: Service;
  readonly solrService: Service;

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
    console.error("orig props:", props);

    assert(props.keycloakUrl == undefined); // not yet supported

    // ensure all volume claims and db credentials are provided 
    checkResourceMap("volume claim", props.volumeClaimProps, shanoirVolumes);
    checkResourceMap("mysql database", props.mysqlDatabases, shanoirMysqlDatabases);
    checkResourceMap("postgresql database", props.postgresqlDatabases, shanoirPostgresqlDatabases);

    // optional features
    const useInternalKeycloak            = props.keycloakUrl == undefined;
    const useInternalMysqlDatabases      = props.mysqlDatabases == undefined;
    const useInternalPostgresqlDatabases = props.postgresqlDatabases == undefined;


    // apply the defaults
    // (after this line, all keys of `props`, `props.smtp` and `props.vip` are defined)
    props = {
      namespace: id,
      ...shanoirNGDefaults, ...props,
      smtp: {...shanoirSmtpDefaults, ...props.smtp },
      vip:  {...shanoirVipDefaults,  ...props.vip },
    };
    console.error("compiled props:", props);

    super(scope, id, props);
    this.props = props;

    if (props.init) {
      this.initChart = new Chart(scope, `danger-${id}-init`, props);
    }

    //////////// namespace ////////////

    if (props.createNamespace) {
      new Namespace(this, "ns", { metadata: { name: props.namespace }});
    }

    //////////// volumes ////////////

    // prepare the volume configs to be used in the containers
    this.volumeClaims = Object.fromEntries(Object.entries(this.props.volumeClaimProps).map(
      ([name, props]) => [name, new PersistentVolumeClaim(this, `${name}-pvc`, props)]));

    this.volumes = Object.fromEntries(Object.entries(this.volumeClaims).map(
      ([name, pvc]) => [name, Volume.fromPersistentVolumeClaim(this, `${name}-rv`, pvc)]));

    //////////// env vars ////////////

    // parse the urls and prepare the environment variables
    this.url = new URL(props.url);
    this.viewerUrl = new URL(props.viewerUrl);

    this.commonConfigMap = this.createCommonConfigMap();

    this.secret = this.createSecret();
    this.smtpEnvVariables = this.createSmtpEnvVariables();
    this.vipEnvVariables = this.createVipEnvVariables();
    this.keycloakCredentialsEnvVariables = this.createKeycloakCredentialsEnvVariables();
    this.dcm4cheeDbEnvVariables = this.createDcm4cheeDbEnvVariables();

    //////////// backend services ////////////

    if (useInternalMysqlDatabases) {
      // deploy an internal mysql container
      this.mysqlService = this.deployMysqlDatabase("database");

      if (useInternalKeycloak) {
        this.keycloakMysqlService = this.deployMysqlDatabase("keycloak-database");
      }
    }

    this.rabbitmqService = this.deployRabbitmq();

    this.solrService = this.deploySolr();

    if (useInternalKeycloak) {
      this.keycloakService = this.deployKeycloak();
    }

    //////////// dcm4chee ////////////
    if (useInternalPostgresqlDatabases) {
      this.postgresqlService = this.createDeployment(this, "dcm4chee-database", [5432], { containers: [{
        image: "dcm4che/postgres-dcm4chee:14.4-27",
        ...noResources,
        volumeMounts: [
          { path: "/var/lib/postgresql/data", volume: this.volumes["dcm4chee-database-data"] },
        ],
        envVariables: this.dcm4cheeDbEnvVariables,
      }]});
    }

    this.dcm4cheeService = this.deployDcm4chee();

    //////////// shanoir micro services ////////////
    this.shanoirService = this.deployShanoir();


    //////////// front ////////////

    if (!this.props.init) {
      this.nginxService = this.deployNginx();

      this.createIngress();

    }
  }

  /** generate the OCI image name for a given shanoir service */
  shanoirImage(service: string): string
  {
    return `${this.props.dockerRepository}/${service}:${this.props.version}`;
  }

  /** get the url of the keycloak service */
  keycloakUrl(): string
  {
    return this.props.keycloakUrl ??  `http://${this.keycloakService!.resourceName!}:8080/auth`;
  }

  /** get the actual parameters for a given mysql database
   *
   * - resolve `host` to this.mysqlService when using the internal database service
   * - set default `port` value
   */
  mysqlDatabase(name: string): ShanoirDatabaseProps {
    const db = this.props.mysqlDatabases![name]!;
    return {...db,
      host: ((db.host != "INTERNAL") ? db.host : 
             (name == "keycloak") ? this.keycloakMysqlService!.resourceName! :
             this.mysqlService!.resourceName!),
      port: db.port ?? 3306,
    };
  }

  /** get the actual parameters for a given postgresql database
   *
   * - resolve `host` to this.postgreqlService when using the internal database service
   * - set default `port` value
   */
  postgresqlDatabase(name: string): ShanoirDatabaseProps {
    const db = this.props.postgresqlDatabases![name]!;
    return {...db,
      host: ((db.host!="INTERNAL") ? db.host : this.postgresqlService!.resourceName!),
      port: db.port ?? 5432,
    };
  }

  createVolumeClaims(): {[key: string]: IPersistentVolumeClaim}
  {
    return Object.fromEntries(Object.entries(this.props.volumeClaimProps).map(
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
      "smtp": this.props.smtp.auth?.password ?? "",
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
      SHANOIR_SMTP_HOST: envValue(this.props.smtp.host),
      SHANOIR_SMTP_PORT: envValue(this.props.smtp.port!.toString()),
      SHANOIR_SMTP_AUTH: envValue((this.props.smtp.auth != undefined).toString()),
      SHANOIR_SMTP_USERNAME: envValue(this.props.smtp.auth?.username ?? ""),
      SHANOIR_SMTP_STARTTLS_ENABLE: envValue((this.props.smtp.starttls != "disabled").toString()),
      SHANOIR_SMTP_STARTTLS_REQUIRED: envValue((this.props.smtp.starttls == "required").toString()),
      SHANOIR_SMTP_FROM: envValue(this.props.smtp.fromAddress),
      SHANOIR_SMTP_PASSWORD: this.secretEnvValue("smtp"),
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
    const uid = this.props.uids![name];
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
   * @return       the created service (if `ports` is defined) or undefined (if `ports` is
   *               undefined)
   *
   * 'props.securityContext' is processed through {@link this.securityContext}.
   */
  private createDeployment<P extends number[]|undefined>(scope: Chart, name: string, ports: P, props: DeploymentProps):
    OptService<P>
  {
    const deploy = new Deployment(scope, `${name}-deploy`, {
      replicas: 1,
      strategy: DeploymentStrategy.recreate(),
      ...props,
      securityContext: this.securityContext(name, props.securityContext),
    });

    if (typeof ports === "undefined") {
      return undefined as OptService<P>;
    } else {
      assert(ports.length);
      return new Service(scope, `${name}-svc`, {
        ports: ports.map((p) => ({port: p, name: p.toString()})),
        selector: deploy
      }) as OptService<P>;
    }
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

  private deployRabbitmq(): Service
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

  private deployMysqlDatabase(name: "database"|"keycloak-database"): Service
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

  private deployKeycloak(): Service
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

  private deploySolr(): Service
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

  private deployDcm4chee(): Service
  {
    const dcm4cheeDb = this.postgresqlDatabase("dcm4chee");

    let service = this.createDeployment(this, "dcm4chee", [8081], {
      // ldap sidecar container
      initContainers: [{
        name: "ldap",
        restartPolicy: ContainerRestartPolicy.ALWAYS,
        image: "dcm4che/slapd-dcm4chee:2.6.2-27.0",
        ...noResources,
        volumeMounts: [
          { path: "/var/lib/openldap/openldap-data", volume: this.volumes["dcm4chee-ldap-data"] },
          { path: "/etc/openldap/slapd.d", volume: this.volumes["dcm4chee-sldap-data"] },
        ],
        envVariables: {
          STORAGE_DIR: envValue("/storage/fs1"),
        },
      }],
      // dcm4chee-arc app container
      containers: [{
        name: "dcm4chee-arc",
        image: "dcm4che/dcm4chee-arc-psql:5.27.0",
        ...noResources,
        volumeMounts: [
          { path: "/opt/wildfly/standalone", volume: this.volumes["dcm4chee-arc-wildfly-data"] },
          { path: "/storage", volume: this.volumes["dcm4chee-arc-storage-data"] },
        ],
        envVariables: {
          ...this.dcm4cheeDbEnvVariables,
          LDAP_URL: envValue(`ldap://127.0.0.1:389`),
          POSTGRES_HOST: envValue(dcm4cheeDb.host),
          POSTGRES_PORT: envValue(dcm4cheeDb.port!.toString()),
          WILDFLY_CHOWN: envValue("/storage"),
          WILDFLY_WAIT_FOR: envValue(`127.0.0.1:389 ${dcm4cheeDb.host}:${dcm4cheeDb.port}`),
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
      externalName: service.resourceName,
    });

    return service;
  }

  private deployShanoir(): Service | undefined
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
            "spring.rabbitmq.host": envValue(self.rabbitmqService.resourceName!),
            "spring.security.oauth2.resourceserver.jwt.issuer-uri":
              envValue(`${self.keycloakUrl()}/realms/shanoir-ng`),

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
              `http://${this.keycloakService!.resourceName}:8080/auth`),
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
            SHANOIR_SOLR_HOST: envValue(this.solrService.resourceName!),
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
      return undefined;

    } else {
      // normal mode
      this.createDeployment(this, "nifti-conversion", undefined, { containers: [
        shanoirContainer("nifti-conversion", false, {
          extraVolumeMounts: [
            { path: "/var/datasets-data", volume: this.volumes["datasets-data"]! },
          ],
        }),
      ]});

      return this.createDeployment(this, "shanoir", [9901, 9902, 9903, 9904, 9905], shanoirProps);
    }
  }

  private deployNginx(): Service
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
        SHANOIR_KEYCLOAK_HOST: envValue(this.keycloakService!.resourceName!),
        SHANOIR_USERS_HOST: envValue(this.shanoirService!.resourceName!),
        SHANOIR_STUDIES_HOST: envValue(this.shanoirService!.resourceName!),
        SHANOIR_IMPORT_HOST: envValue(this.shanoirService!.resourceName!),
        SHANOIR_DATASETS_HOST: envValue(this.shanoirService!.resourceName!),
        SHANOIR_PRECLINICAL_HOST: envValue(this.shanoirService!.resourceName!),
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
    let keycloakRules = undefined;

    if (ingress.tlsCrt && ingress.tlsKey) {
      tls = [{
        hosts: [this.url.host, this.viewerUrl.host],
        secret: new Secret(this, "tls-sec", { stringData: {
          "tls.crt": ingress.tlsCrt,
          "tls.key": ingress.tlsKey,
        }})}];
    }

    if (this.keycloakService != undefined && ingress.exposeKeycloakAdminConsole) { 
      let keycloakBackend = IngressBackend.fromService(this.keycloakService);
      keycloakRules = [
        { host: this.url.host, path: "/auth/admin/", backend: keycloakBackend},
        { host: this.url.host, path: "/auth/realms/master/", backend: keycloakBackend},
      ];
    }

    let nginxBackend = IngressBackend.fromService(this.nginxService!);

    return new Ingress(this, "ing", {
      className: ingress.className,
      metadata: {
        annotations: {
          // FIXME: shanoir should never return a http: url
          "nginx.ingress.kubernetes.io/proxy-redirect-from": `http://${this.url.host}`,
          "nginx.ingress.kubernetes.io/proxy-redirect-to":  `https://${this.url.host}`,
        },
      },
      tls: tls,
      rules: [
        { host: this.url.host, backend: nginxBackend },
        { host: this.viewerUrl.host, backend: nginxBackend },
        ...(keycloakRules ?? [])
      ],
    });
}
}
