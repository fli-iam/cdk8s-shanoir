
import { ChartProps } from "cdk8s";
import { PersistentVolumeClaimProps } from "cdk8s-plus-33";


export interface ShanoirCredentials {
  readonly username: string;
  readonly password: string;
}

/** Parameters for accessing a Mysql/Mariadb/Posgresql database */
export interface ShanoirDatabaseProps extends ShanoirCredentials {
  readonly db: string;
  readonly host: string;
  readonly port?: number;
}

/** Default values for {@link ShanoirSmtpProps} */
export const shanoirSmtpDefaults = {
  port: 25,
  auth: undefined,
  starttls: "disabled" as "disabled",
};

/** SMTP configuration for outgoing mails */
export interface ShanoirSmtpProps {

  /** relay hostname/ip */
  readonly host: string;

  /** relay TCP port
   *
   * @default see {@link shanoirSmtpDefaults}
   */
  readonly port?: number;

  /** smtp user account
   *
   * @default no authentication
   */
  readonly auth?: ShanoirCredentials;

  /** STARTTLS configuration
   *
   * @default see {@link shanoirSmtpDefaults}
   */
  readonly starttls?: "disabled" | "optional" | "required";

  /** default sender address */
  readonly fromAddress: string;
}

/** Default values for {@link ShanoirVipProps} */
export const shanoirVipDefaults = {
  url: "https://vip.creatis.insa-lyon.fr",
  clientSecret: "SECRET",
  serviceEmail: "",
};

/** VIP (Virtual Imaging Platform) client configuration */
export interface ShanoirVipProps {
  readonly url: string;
  readonly clientSecret: string;
  readonly serviceEmail: string;
}


export const shanoirVolumes = [
  // medical data
  "datasets-data",
  "dcm4chee-arc-storage-data",
  "extra-data",
  "studies-data",

  // databases
  "database-data",
  "dcm4chee-database-data",
  "keycloak-database-data",

  // logs
  "logs",
  "keycloak-logs",

  // disposable data (temporary data, indexes, generated configs, ...)
  "dcm4chee-arc-wildfly-data",
  "dcm4chee-ldap-data",
  "dcm4chee-sldap-data",
  "rabbitmq-data",
  "solr-data",
  "tmp",
];

/** List of mysql databases to be provide in {@link ShanoirNGProps.mysqlDatabases} */
export const shanoirMysqlDatabases = [
  "datasets",
  "import",
  "keycloak",
  "migrations",
  "mysql",
  "preclinical",
  "studies",
  "sys",
  "users",
];

export const shanoirPostgresqlDatabases = [
  "dcm4chee",
];

function defaultMysqlDatabases(): {[key: string]: ShanoirDatabaseProps}
{
  var dbProps: {[key: string]: ShanoirDatabaseProps} = {};
  for (let db of shanoirMysqlDatabases) {
    dbProps[db] = {
      host: "database",
      db: db,
      username: db,
      password: db,
    };
  }
  return dbProps;
}

function defaultPostgresqlDatabases(): {[key: string]: ShanoirDatabaseProps}
{
  return {
    "dcm4chee": {
      host: "dcm4chee-database",
      db: "pacsdb",
      username: "pacs",
      password: "pacs",
    }};
}


/** Default values for {@link ShanoirNGProps} */
export const shanoirNGDefaults = {
  version: "NG_v2.9.2",
  instanceName: "",
  instanceColor: "",
  dockerRepository: "ghcr.io/fli-iam/shanoir-ng",
  allowedAdminIps: [],
  smtp: shanoirSmtpDefaults,
  vip: shanoirVipDefaults,
  createNamespace: true,
  mysqlDatabases: defaultMysqlDatabases(),
  postgresqlDatabases: defaultPostgresqlDatabases(),
};

export interface ShanoirNGProps extends ChartProps {

  /** Version of shanoir to be deployed (tag of the OCI images)
   *
   * @default use the latest release
   */
  readonly version?: string;

  /** Main url of this shanoir instance */
  readonly url: string;

  /** Url of the OHIF viewer */
  readonly viewerUrl: string;

  /** Name of this shanoir instance (displayed in the side panel) */
  readonly instanceName?: string;

  /** CSS color of this shanoir instance */
  readonly instanceColor?: string;

  /** Name of the administrator (for signing outgoing e-mails) */
  readonly adminName: string;

  /** E-mail of the administrator (for signing outgoing e-mails) */
  readonly adminEmail: string;

  /** Name of the OCI repository providing the shanoir images
   *
   * @default see {@link shanoirNGPropsDefaults}
   */
  readonly dockerRepository?: string;

  /** Mysql databases parameters
   *
   * If unset, this deployment will include a mysql container for hosting the databases.
   *
   * Otherwise the object must contain all keys listed in {@link shanoirMysqlDatabases}
   * (except 'keycloak' which may be omitted when using an external keycloak server)
   */
  readonly mysqlDatabases?: {[key: string]: ShanoirDatabaseProps};

  /** Postgresql databases 
   *
   * If unset, this deployment will include a postgresql container for hosting the databases.
   *
   * Otherwise the object must contain all keys listed in {@link shanoirPostgresqlDatabases}
   */
  readonly postgresqlDatabases?: {[key: string]: ShanoirDatabaseProps};

  /** SMTP parameters for outgoing emails */
  readonly smtp: ShanoirSmtpProps;

  /** List of client IP address or networks from which admin accounts are allowed to log in.
  *
  * @example ["192.0.2.1", "2001:db8:1::/64"]
  */
  readonly allowedAdminIps?: Array<string>;

  /** Url of the keycloak server (if external)
  *
  * If unset, this deployment will include a keycloak container reachable at `${this.url}/auth/`
  */
  readonly keycloakUrl?: string;

  /** Keycloak account (master realm) for managing users */
  readonly keycloakCredentials: ShanoirCredentials;

  /** VIP (Virtual Imaging Platform) client configuration
  *
  * Used by the CARMIN-API-CLIENT in the front of shanoir-ng to query for pipelines
  */
  readonly vip?: ShanoirVipProps;

  /** Volumes claim properties for this shanoir instance */
  readonly volumeClaimProps: { [key: string]: PersistentVolumeClaimProps};

  /** Create the kubernetes namespace
   *
   * @default see {@link shanoirNGPropsDefaults}
   */
  readonly createNamespace?: boolean;
}
