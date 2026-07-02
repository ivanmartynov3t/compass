# MongoDB Compass Security Testing Summary

This document lists specific instances of security-relevant testing that is being
performed for MongoDB Compass. All parts of the MongoDB Compass source code
are subject to integration and unit testing on every change made to the project,
including the specific instances listed below.

# Security Tests

## Atlas Login Integration Tests

The Atlas Login feature is thoroughly tested, including proper authentication token
handling and credential revocation upon signout.

<!-- Source File: `packages/atlas-service/src/main.spec.ts` -->

## Connection Import / Export Testing

Compass allows users to export and import connections. Our tests verify that
the application informs the user about what this feature does, and in particular
that encryption for credentials is correctly applied.

<!-- Source File: `packages/compass-e2e-tests/tests/import-export-connections.test.ts` -->

## In-Use Encryption Testing

MongoDB supports a set of features referred to as "In-Use Encryption".
The most sensitive data handled as part of these features are Key Management System
credentials -- our tests verify that these are not stored, unless the user explicitly
requests that behavior.

Additionally, the application provides a layer of protection for users against
accidental misconfiguration: When updating decrypted data coming from the server,
we ensure that when writing back into the database, it is always encrypted again,
and never sent in plaintext.

<!-- Source File: `packages/compass-e2e-tests/tests/in-use-encryption.test.ts` -->

## Enhanced Network Isolation Tests

Compass allows users to specify that the application should not perform any
network calls that are not necessary for interacting with MongoDB clusters,
partially because users may consider this deployment more more secure, even
if it comes with a reduced feature set.
We ensure that no such network calls happen when this setting is enabled.

<!-- Source File: `packages/compass-e2e-tests/tests/no-network-traffic.test.ts` -->

## OIDC Authentication End-to-End Tests

In addition to our regular tests for the different authentication mechanisms supported
by MongoDB, we give special consideration to our OpenID Connect database authentication
feature, as it involves client applications performing actions based on directions
received from the database server.

Additionally, we verify that Compass stores credentials in a way that is consistent with
what the user has previously specified.

<!-- Source File: `packages/compass-e2e-tests/tests/oidc.test.ts` -->

## Connection String Credential Protection Tests

Compass provides a user- or administrator-configurable setting that prevents the application
from displaying credentials to avoid accidental leakage. Our tests verify that features
which expose connection information honor this setting.

<!-- Source File: `packages/compass-e2e-tests/tests/protect-connection-strings.test.ts` -->

## Kerberos Password Field Visibility Tests

Compass supports Kerberos (GSSAPI) authentication, which optionally accepts
a Kerberos password for specific deployment configurations. By default,
this field is hidden to minimise credential exposure in the connection form.
These tests verify that the field is hidden when the feature flag is disabled
and visible when it is explicitly enabled by an administrator, ensuring that
credentials are not presented to users unless intentionally configured.

<!-- Source File: `packages/compass-e2e-tests/tests/show-kerberos-password-field.test.ts` -->

## Connection String Credential Redaction Tests

Compass provides a setting that prevents the application from displaying
credentials in connection strings, to avoid accidental leakage to
bystanders or screenshots. These tests verify that when this protection
is active, credentials are fully redacted from the displayed connection
string, while the connection string is passed through unmodified when
the protection is not active.

<!-- Source File: `packages/compass-maybe-protect-connection-string/src/index.spec.ts` -->

## Sensitive Preferences Encryption Tests

Compass persists user preferences to disk, some of which contain sensitive
information such as proxy passwords and SSH private key passphrases.
These tests verify that sensitive preference fields are encrypted at rest:
non-secret values remain readable on disk, while secrets such as passwords
and passphrases are never stored in plaintext.

<!-- Source File: `packages/compass-preferences-model/src/preferences-persistent-storage.spec.ts` -->

## Automatic Connection Establishment Tests

Since this application accepts remote host connection information on the command line,
we thoroughly check such arguments to verify that they do not result in surprising
behavior for users. In particular, our tests verify that the application warns users
about options that seem unusual or may not result in unexpected or dangerous application
behavior.

<!-- Source File: `packages/compass/src/main/auto-connect.spec.ts` -->

## Connection Form Password Protection

We verify that database credentials are not displayed to users, unless they
are actively in the process of editing them.

<!-- Source File: `packages/connection-form/src/components/connection-string-input.spec.tsx` -->

## Connection Option Validation Rules

We explicitly verify that the application warns users about connection settings
that may result in security issues, for example potentially insecure TLS or Proxy settings.

<!-- Source File: `packages/connection-form/src/utils/validation.spec.ts` -->

## Secure Credential Storage

We ensure that when sensitive information is persisted, in particular database access credentials,
it is cryptographically protected through an OS keychain encryption integration.

<!-- Source File: `packages/connection-info/src/connection-secrets.spec.ts` -->

## In-Use Encryption Re-Encryption Assurance Tests

MongoDB's In-Use Encryption features allow data to be stored and retrieved
in encrypted form. A critical security property is that when decrypted data
is written back into the database, it must always be re-encrypted —
never sent in plaintext. These tests verify that the CSFLE collection
tracker correctly enforces this invariant, preventing accidental plaintext
exposure of data that the user intended to keep encrypted.

<!-- Source File: `packages/data-service/src/csfle-collection-tracker.spec.ts` -->
