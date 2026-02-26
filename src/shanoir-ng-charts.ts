import { strict as assert } from "assert";
import { Construct } from "constructs";
import { Chart } from "cdk8s";
import {
  ConfigMap, ContainerProps, Deployment, EnvFrom, EnvValue, IPersistentVolumeClaim, Namespace,
  PersistentVolumeClaim, Secret, Service, Volume, VolumeMount } from "cdk8s-plus-33";
import { URL } from "whatwg-url";

import {
  ShanoirNGProps, shanoirNGDefaults, shanoirMysqlDatabases, shanoirPostgresqlDatabases,
  shanoirSmtpDefaults, shanoirVipDefaults, shanoirVolumes,
} from "./shanoir-ng-props";

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

type OptService<T> = T extends undefined ? undefined : Service;

export class ShanoirNGChart extends Chart
{
  readonly props: ShanoirNGProps;
  readonly commonConfigMap: ConfigMap;
  readonly secret: Secret;
  readonly volumes: {[key: string]: Volume};
  readonly volumeClaims: {[key: string]: IPersistentVolumeClaim};

  readonly databaseService?: Service;

  constructor(scope: Construct, id: string, props: ShanoirNGProps)
  {
    console.error("orig props:", props);

    assert(props.mysqlDatabases == undefined); // not yet supported
    assert(props.postgresqlDatabases == undefined); // not yet supported
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

    // prepare the volume configs to be used in the containers
    this.volumeClaims = Object.fromEntries(Object.entries(this.props.volumeClaimProps).map(
      ([name, props]) => [name, new PersistentVolumeClaim(this, `${name}-pvc`, props)]));

    this.volumes = Object.fromEntries(Object.entries(this.volumeClaims).map(
      ([name, pvc]) => [name, Volume.fromPersistentVolumeClaim(this, `${name}-rv`, pvc)]));


    // prepare the environment variables
    this.commonConfigMap = this.createCommonConfigMap();

    this.secret = this.createSecret();
    const smtpEnvVariables = this.createSmtpEnvVariables();
    const vipEnvVariables = this.createVipEnvVariables();
    const keycloakCredentialsEnvVariables = this.createKeycloakCredentialsEnvVariables();

    //////////// namespace ////////////

    if (props.createNamespace) {
      new Namespace(this, "ns", { metadata: { name: props.namespace }});
    }

    //////////// backend services ////////////

    if (useInternalMysqlDatabases) {
      this.createService("database", [3306], {
        image: this.shanoirImage("database"),
        args: [
          "--max_allowed_packet",
          "20000000",
          // Fix k8s and old mysql
          // https://stackoverflow.com/questions/37644118/initializing-mysql-directory-error
          "--ignore-db-dir=lost+found",
        ],
        envVariables: {
          "MYSQL_ROOT_PASSWORD": EnvValue.fromValue("password"),
          "SHANOIR_MIGRATION": EnvValue.fromConfigMap(this.commonConfigMap, "never"),
        },
        volumeMounts: [
          { path: "/var/lib/mysql", volume: this.volumes["database-data"] },
        ],
      });
    }

    this.createService("rabbitmq", [5672], {
      image: "rabbitmq:3.10.7",
      volumeMounts: [
        { path: "/var/lib/rabbitmq/mnesia/rabbitmq", volume: this.volumes["rabbitmq-data"] },
      ]
    });

    this.createService("solr", [8983], {
      image: this.shanoirImage("solr"),
      envVariables: {
        SOLR_LOG_LEVEL: EnvValue.fromValue("SEVERE"),
      },
      volumeMounts: [{ path: "/var/solr", volume: this.volumes["solr-data"] }],
    });

    if (useInternalKeycloak) {

      this.createService("keycloak", [8080], {
        image: this.shanoirImage("keycloak"),
        envFrom: [new EnvFrom(this.commonConfigMap)],
        envVariables: {
          ...keycloakCredentialsEnvVariables,
          ...smtpEnvVariables,
          SHANOIR_ALLOWED_ADMIN_IPS: EnvValue.fromValue(this.props.allowedAdminIps!.join(",")),
        },
      });
    }

    //////////// dcm4chee ////////////

    const dcm4cheeDb = this.props.postgresqlDatabases!["dcm4chee"]!;
    const dcm4cheeDbVariables = {
      POSTGRES_DB:       EnvValue.fromValue(dcm4cheeDb.db),
      POSTGRES_USER:     EnvValue.fromValue(dcm4cheeDb.username),
      POSTGRES_PASSWORD: EnvValue.fromSecretValue({key: "dcm4chee", secret: this.secret}),
    };

    this.createService("dcm4chee-ldap", [389], {
      image: "dcm4che/slapd-dcm4chee:2.6.2-27.0",
      volumeMounts: [
        { path: "/var/lib/openldap/openldap-data", volume: this.volumes["dcm4chee-ldap-data"] },
        { path: "/etc/openldap/slapd.d", volume: this.volumes["dcm4chee-sldap-data"] },
      ],
      envVariables: {
        STORAGE_DIR: EnvValue.fromValue("/storage/fs1"),
      },
    });

    if (useInternalPostgresqlDatabases) {
      this.createService("dcm4chee-database", [5432], {
        image: "dcm4che/postgres-dcm4chee:14.4-27",
        volumeMounts: [
          { path: "/var/lib/postgresql/data", volume: this.volumes["dcm4chee-database-data"] },
        ],
        envVariables: dcm4cheeDbVariables,
      });
    }

    this.createService("dcm4chee-arc", [8080], {
      image: "dcm4che/dcm4chee-arc-psql:5.27.0",
      volumeMounts: [
        { path: "/opt/wildfly/standalone", volume: this.volumes["dcm4chee-arc-wildfly-data"] },
        { path: "/storage", volume: this.volumes["dcm4chee-arc-storage-data"] },
      ],
      envVariables: {
        ...dcm4cheeDbVariables,
        LDAP_URL: EnvValue.fromValue(`ldap://dcm4chee-ldap:389`),
        POSTGRES_HOST: EnvValue.fromValue(dcm4cheeDb.host),
        WILDFLY_CHOWN: EnvValue.fromValue("/storage"),
        WILDFLY_WAIT_FOR: EnvValue.fromValue("dcm4chee-ldap:389 dcm4chee-database:5432")
    }});

    //////////// shanoir micro services ////////////

    this.createShanoirMicroservice("users", [9901], {
      envVariables: {
        ...keycloakCredentialsEnvVariables,
        ...smtpEnvVariables,
        "VIP_SERVICE_EMAIL": EnvValue.fromValue(props.vip!.serviceEmail),
      }
    });

    this.createShanoirMicroservice("studies", [9902], {
      extraVolumeMounts: [
        { path: "/tmp", volume: this.volumes["tmp"] },
        { path: "/var/studies-data", volume: this.volumes["studies-data"] },
        // This is related to participants.tsv file
        { path: "/var/datasets-data", volume: this.volumes["datasets-data"] },
      ],
    });

    this.createShanoirMicroservice("import", [9903], {
      extraVolumeMounts: [
        { path: "/tmp", volume: this.volumes["tmp"] },
      ],
    });

    this.createShanoirMicroservice("datasets", [9904], {
      envVariables: {
        ...vipEnvVariables,
        VIP_CLIENT_SECRET: EnvValue.fromSecretValue({ secret: this.secret, key: "vip-client-secret" }),
      },
      extraVolumeMounts: [
        { path: "/tmp", volume: this.volumes["tmp"] },
        { path: "/var/datasets-data", volume: this.volumes["datasets-data"] },
      ],
    });

    this.createShanoirMicroservice("preclinical", [9905], {
      extraVolumeMounts: [
        { path: "/tmp", volume: this.volumes["tmp"] },
        { path: "/var/extra-data", volume: this.volumes["extra-data"] },
      ],
    });

    this.createShanoirMicroservice("nifti-conversion", undefined, {
      extraVolumeMounts: [
        { path: "/tmp", volume: this.volumes["tmp"] },
        { path: "/var/datasets-data", volume: this.volumes["datasets-data"] },
      ],
    });

    //////////// front ////////////

    this.createService("nginx", [80, 443], {
      image: this.shanoirImage("nginx"),
      volumeMounts: [
        { path: "/var/log/nginx", volume: this.volumes["logs"], subPath: "nginx" },
      ],
      envFrom: [ new EnvFrom(this.commonConfigMap)],
      envVariables: vipEnvVariables,
    });
  }

  /** generate the OCI image name for a given shanoir service */
  shanoirImage(service: string): string
  {
    return `${this.props.dockerRepository}/${service}:${this.props.version}`;
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

  /** common config map for all shanoir microservices */
  createCommonConfigMap(): ConfigMap
  {
    const url = new URL(this.props.url);
    assert(url.port == "");
    assert(url.pathname == "/");
    const viewerUrl = new URL(this.props.viewerUrl);
    assert(viewerUrl.port == "")
    assert(viewerUrl.pathname == "/")


    return new ConfigMap(this, "common-cm", { data: {
      SHANOIR_PREFIX: "",
      SHANOIR_URL_SCHEME: url.protocol.replace(/:$/, ""),
      SHANOIR_URL_HOST: url.host,
      SHANOIR_VIEWER_OHIF_URL_SCHEME: viewerUrl.protocol.replace(/:$/, ""),
      SHANOIR_VIEWER_OHIF_URL_HOST: viewerUrl.host,

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
      SHANOIR_SMTP_HOST: EnvValue.fromValue(this.props.smtp.host),
      SHANOIR_SMTP_PORT: EnvValue.fromValue(this.props.smtp.port!.toString()),
      SHANOIR_STMP_AUTH: EnvValue.fromValue((this.props.smtp.auth != undefined).toString()),
      SHANOIR_SMTP_USERNAME: EnvValue.fromValue(this.props.smtp.auth?.username ?? ""),
      SHANOIR_SMTP_STARTTLS_ENABLE: EnvValue.fromValue((this.props.smtp.starttls != "disabled").toString()),
      SHANOIR_SMTP_STARTTLS_REQUIRED: EnvValue.fromValue((this.props.smtp.starttls == "required").toString()),
      SHANOIR_SMTP_FROM: EnvValue.fromValue(this.props.smtp.fromAddress),
      SHANOIR_SMTP_PASSWORD: EnvValue.fromSecretValue({secret: this.secret, key: "smtp"}),
    };
  }

  private createVipEnvVariables(): { [key: string]: EnvValue }
  {
    const url = new URL(this.props.vip!.url);
    assert(url.port == "");
    assert(url.pathname == "/");

    return {
      VIP_URL_SCHEME: EnvValue.fromValue(url.protocol.replace(/:$/, "")),
      VIP_URL_HOST: EnvValue.fromValue(url.host),
    };

  }

  private createKeycloakCredentialsEnvVariables(): { [key: string]: EnvValue }
  {
    return {
      SHANOIR_KEYCLOAK_USER: EnvValue.fromValue(this.props.keycloakCredentials.username),
      SHANOIR_KEYCLOAK_PASSWORD: EnvValue.fromSecretValue({ secret: this.secret, key: "keycloak-admin" }),
    };
  }

  /** common generic function for creating a deployment + an associated service
   *
   * @param name   name of the service
   * @param ports  list of TCP ports included in the service
   * @param props  properties of the deployed container
   * @return       the created service (if `ports` is defined) or undefined (if `ports` is
   *               undefined)
   */
  private createService<P extends number[]|undefined>(name: string, ports: P, props: ContainerProps):
    OptService<P>
  {
    const deploy = new Deployment(this, `${name}-deploy`, {
      containers: [props],
    });

    if (typeof ports === "undefined") {
      return undefined as OptService<P>;
    } else {
      assert(ports.length);
      return new Service(this, `${name}-svc`, {

        // We do not const cdk8s autogenerate the service names because these names ("database",
        // "users", ...) are hardcoded in the shanoir images for the moment (which would break service
        // discovery)
        metadata: { name: name },

        ports: ports.map((p) => ({port: p})),
        selector: deploy
      }) as OptService<P>;
    }
  }

  /** common generic function for creating a shanoir microservice deployment+service
   *
   * This function does the same as {@link createService}, but with additional common settings
   *  - set container image
   *  - use the {@link commonConfigMap}
   *  - mount the `logs` volume)
   */
  private createShanoirMicroservice<P extends number[]|undefined>(name: string, ports: P, props: {
    envVariables?: { [key: string]: EnvValue },
    extraVolumeMounts?: VolumeMount[],
  }): OptService<P>
  {
    return this.createService(name, ports, {
        image: this.shanoirImage(name),
        envFrom: [ new EnvFrom(this.commonConfigMap), ],
        envVariables: props.envVariables ?? {},
        volumeMounts: [
          { path: "/var/log/shanoir-ng-logs", volume: this.volumes["logs"]! },
          ...(props.extraVolumeMounts ?? [])
        ],
    });
  }
}
