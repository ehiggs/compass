import type { CompassBrowser } from '../helpers/compass-browser';
import { beforeTests, afterTests, afterTest } from '../helpers/compass';
import type { Compass } from '../helpers/compass';
import type { OIDCMockProviderConfig } from '@mongodb-js/oidc-mock-provider';
import { OIDCMockProvider } from '@mongodb-js/oidc-mock-provider';
import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';
import { getDownloadURL } from 'mongodb-download-url';
import tar from 'tar';
import { promisify } from 'util';
import type { Readable } from 'stream';
import { pipeline, PassThrough } from 'stream';
import { createInterface as readline } from 'readline';
import https from 'https';
import { once } from 'events';
import { expect } from 'chai';

describe('OIDC integration', function () {
  let compass: Compass;
  let browser: CompassBrowser;

  let getTokenPayload: typeof oidcMockProviderConfig.getTokenPayload;
  let oidcMockProviderConfig: OIDCMockProviderConfig;
  let oidcMockProvider: OIDCMockProvider;

  let i = 0;
  let tmpdir: string;
  let server: ChildProcess;
  let serverExit: Promise<unknown>;
  let connectionString: string;

  before(async function () {
    // TODO(MONGOSH-1306): Get rid of all the setup code to download mongod here... :(
    if (process.platform !== 'linux') {
      // OIDC is only supported on Linux in the 7.0+ enterprise server.
      return this.skip();
    }

    {
      oidcMockProviderConfig = {
        getTokenPayload(metadata: Parameters<typeof getTokenPayload>[0]) {
          return getTokenPayload(metadata);
        },
      };
      oidcMockProvider = await OIDCMockProvider.create(oidcMockProviderConfig);
    }

    {
      tmpdir = path.join(
        os.tmpdir(),
        `compass-oidc-${Date.now().toString(32)}-${++i}`
      );
      await fs.mkdir(path.join(tmpdir, 'db'), { recursive: true });
    }

    {
      const { url } = await getDownloadURL({
        version: '>= 7.0.0-rc0',
        enterprise: true,
      });

      await promisify(pipeline)(
        await new Promise<Readable>((resolve) => https.get(url, resolve).end()),
        tar.x({ cwd: tmpdir, strip: 1 })
      );
    }

    {
      const serverOidcConfig = {
        issuer: oidcMockProvider.issuer,
        clientId: 'testServer',
        requestScopes: ['mongodbGroups'],
        authorizationClaim: 'groups',
        audience: 'resource-server-audience-value',
        authNamePrefix: 'dev',
      };

      server = spawn(
        path.join(tmpdir, 'bin', 'mongod'),
        [
          '--setParameter',
          'authenticationMechanisms=SCRAM-SHA-256,MONGODB-OIDC',
          // enableTestCommands allows using http:// issuers such as http://localhost
          '--setParameter',
          'enableTestCommands=true',
          '--setParameter',
          `oidcIdentityProviders=${JSON.stringify([serverOidcConfig])}`,
          '--dbpath',
          path.join(tmpdir, 'db'),
          '--port',
          '0',
        ],
        {
          cwd: tmpdir,
          stdio: ['inherit', 'pipe', 'inherit'],
        }
      );

      serverExit = once(server, 'exit');

      const port = await Promise.race([
        serverExit.then((code) => {
          throw new Error(`mongod exited with code ${code}`);
        }),
        (async () => {
          // Parse the log output written by mongod to stdout until we know
          // which port it chose.
          const pt = new PassThrough();
          server.stdout?.pipe(pt);
          if (process.env.CI) server.stdout?.pipe(process.stderr);
          for await (const l of readline({ input: pt })) {
            const line = JSON.parse(l);
            if (line.id === 23016 /* Waiting for connections */) {
              server.stdout?.unpipe(pt); // Ignore all further output
              return line.attr.port;
            }
          }
        })(),
      ]);

      connectionString = `mongodb://127.0.0.1:${port}/?authMechanism=MONGODB-OIDC`;
    }

    process.env.COMPASS_TEST_OIDC_BROWSER_DUMMY = `${
      process.execPath
    } ${path.resolve(__dirname, '..', 'fixtures', 'curl.js')}`;
  });

  beforeEach(async function () {
    compass = await beforeTests();
    browser = compass.browser;
  });

  afterEach(async function () {
    await afterTest(compass, this.currentTest);
  });

  after(async function () {
    delete process.env.COMPASS_TEST_OIDC_BROWSER_DUMMY;
    await afterTests(compass, this.currentTest);
    server?.kill();
    await serverExit;
    await oidcMockProvider?.close();
    if (tmpdir) await fs.rmdir(tmpdir, { recursive: true });
  });

  it('can successfully connect', async function () {
    let tokenFetchCalls = 0;
    getTokenPayload = () => {
      tokenFetchCalls++;
      return {
        expires_in: 3600,
        payload: {
          // Define the user information stored inside the access tokens
          groups: ['testgroup'],
          sub: 'testuser',
          aud: 'resource-server-audience-value',
        },
      };
    };
    await browser.connectWithConnectionString(connectionString);
    const result: any = await browser.shellEval(
      'db.runCommand({ connectionStatus: 1 })',
      true
    );

    expect(tokenFetchCalls).to.equal(1); // No separate request from the shell
    expect(result.authInfo).to.deep.equal({
      authenticatedUsers: [{ user: 'dev/testuser', db: '$external' }],
      authenticatedUserRoles: [{ role: 'dev/testgroup', db: 'admin' }],
    });
  });
});
