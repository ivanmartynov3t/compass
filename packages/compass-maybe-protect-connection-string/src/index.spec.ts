import { maybeProtectConnectionString } from './';
import { expect } from 'chai';

const connectionString = 'mongodb://username:p4ssw0rd@localhost/';

/**
 * @securityTest Connection String Credential Redaction Tests
 *
 * Compass provides a setting that prevents the application from displaying
 * credentials in connection strings, to avoid accidental leakage to
 * bystanders or screenshots. These tests verify that when this protection
 * is active, credentials are fully redacted from the displayed connection
 * string, while the connection string is passed through unmodified when
 * the protection is not active.
 */
describe('maybeProtectConnectionString', function () {
  it('passes input through if not in protected mode', function () {
    expect(maybeProtectConnectionString(false, connectionString)).to.equal(
      connectionString
    );
  });

  it('redacts credentials in protected mode', function () {
    expect(maybeProtectConnectionString(true, connectionString)).to.equal(
      'mongodb://<credentials>@localhost/'
    );
  });
});
