# QR Shop Backend Interface

> A controlled communication interface through which authorized QR Shop clients may perform permitted operations without acquiring knowledge of the systems, technologies, or infrastructure responsible for processing those operations.

---

## Introduction

The **QR Shop Backend Interface** defines the external communication contract through which authorized client applications may exchange structured requests and responses with the QR Shop service environment; rather than documenting the mechanisms by which those requests are internally processed, this specification deliberately confines itself to the behavior that a legitimate client is expected to observe.

Because implementation details that provide no functional value to an external client may simultaneously provide unnecessary reconnaissance value to an unauthorized party, information concerning internal technologies, service dependencies, deployment topology, storage mechanisms, administrative interfaces, and processing architecture has intentionally been excluded from this document.

The governing principle is therefore straightforward in concept, although deliberately rigorous in execution:

> **Expose the contract that a client requires while withholding the architecture that the client has no legitimate reason to know.**

*Le contrat reste public; l'infrastructure demeure privée.*

---

# Scope of the Interface

Although the interface provides a standardized mechanism through which client requests may be submitted, validated, processed, and answered, this document does not attempt to describe how those operations are fulfilled internally.

The public interface is principally concerned with:

- request formulation and routing conventions;
- authentication requirements and authorization boundaries;
- request-body and query-parameter expectations;
- predictable response structures;
- standardized error semantics;
- transactional integrity;
- abuse resistance and request limitation;
- connectivity and service-availability behavior;
- compatibility expectations between client versions and service revisions.

Any implementation-specific mechanism that does not alter the external contract remains intentionally outside the scope of this specification.

---

# Interface Philosophy

Rather than allowing the public contract to mirror internal implementation structures, the QR Shop Backend Interface establishes an independently governed request model whose stability can be preserved even when the underlying service environment changes substantially.

Consequently, a client should concern itself with questions such as:

```text
Which route should be requested?

Which HTTP method should be used?

Which parameters must accompany the request?

Which authorization context is required?

Which response structure should be expected?

Which error conditions may legitimately be returned?
```

Conversely, a client should neither require nor receive answers to questions such as:

```text
Which internal technology executes the request?

Where is the service physically or logically hosted?

Which internal systems participate in processing?

How is persistent information stored?

Which administrative services exist behind the interface?

Which internal credentials or service identities are employed?
```

By maintaining this separation, the public interface remains stable while the private implementation may evolve independently.

---

# Request Routing Convention

Rather than adopting a generic `/api/...` namespace, client-facing operations are organized beneath a dedicated request hierarchy whose semantics remain explicit and predictable.

The canonical structure is:

```text
/backend/request/<resource>/<operation>/
```

Representative requests include:

```text
/backend/request/login/

/backend/request/product/list/

/backend/request/product/detail/?id=101

/backend/request/customer/detail/?id=501

/backend/request/order/create/

/backend/request/order/status/?id=8001
```

Within this convention, the route may be interpreted hierarchically as follows:

```text
backend
   ↓
request
   ↓
resource
   ↓
operation
```

Accordingly, the following request:

```text
/backend/request/product/detail/?id=101
```

expresses the intention to obtain a detailed representation of the product whose externally recognized identifier is `101`, without revealing how that representation is internally assembled.

*La route décrit l'intention, non l'implémentation.*

---

# Service Address

Because endpoint locations may differ between environments, deployment stages, or operational configurations, the actual service hostname should be supplied through an authorized configuration mechanism rather than unnecessarily embedded within public documentation.

Conceptually, a request may therefore be represented as:

```text
https://<authorized-service-host>/backend/request/product/list/
```

Although a production client will necessarily possess a valid endpoint, public documentation need not enumerate alternative hosts, infrastructure-specific aliases, administrative domains, or fallback topology unless such disclosure is operationally required.

---

# Transport Requirements

All production communication must occur through an encrypted transport channel, while requests that cannot satisfy the required transport guarantees should be rejected before any protected operation is attempted.

Unless otherwise documented for a specific operation, request and response payloads are exchanged as structured JSON.

Example:

```http
Content-Type: application/json
```

Protected requests should additionally transmit an appropriate authorization credential:

```http
Authorization: Bearer <access_token>
```

Credentials whose disclosure could grant unauthorized access must never be transmitted through URL query parameters, since URLs may be retained by browser history, reverse proxies, analytics systems, diagnostic tooling, or request logs.

Consequently, the following pattern is prohibited:

```text
/backend/request/login/?password=example-password
```

whereas an authenticated request body remains acceptable:

```http
POST /backend/request/login/
```

```json
{
  "login": "user@example.com",
  "password": "example-password"
}
```

---

# Authentication

Authentication establishes the identity associated with a request; authorization, which remains a distinct concern, determines whether that identity may perform the requested operation.

A successful authentication attempt may return an access credential whose subsequent presentation permits protected requests to be evaluated within the appropriate authorization context.

## Login Request

```http
POST /backend/request/login/
```

Example body:

```json
{
  "login": "user@example.com",
  "password": "example-password"
}
```

A successful response may resemble:

```json
{
  "success": true,
  "data": {
    "user_id": 501,
    "name": "Example User",
    "access_token": "..."
  }
}
```

Where authentication cannot be established, the response should remain sufficiently general that it does not unnecessarily disclose which component of the supplied credentials was incorrect.

```json
{
  "success": false,
  "error": {
    "code": "INVALID_CREDENTIALS",
    "message": "The supplied credentials could not be authenticated."
  }
}
```

Rather than revealing whether an account exists, whether a password alone was incorrect, or whether some internal account condition caused the rejection, externally observable authentication failures should disclose only what is necessary for legitimate client behavior.

---

# Logout

Where the authentication model permits explicit session termination, the client may request logout through:

```http
POST /backend/request/logout/
```

A successful response may be represented as:

```json
{
  "success": true,
  "message": "The authenticated session has been terminated."
}
```

Any internal invalidation mechanism that accompanies this operation remains deliberately undocumented because it forms no part of the client-facing contract.

---

# Current User

An authenticated client may request information associated with its present authorization context through:

```http
GET /backend/request/user/current/
```

Example:

```json
{
  "success": true,
  "data": {
    "id": 501,
    "name": "Example User"
  }
}
```

Only information required by the authorized client should be included, while attributes whose disclosure serves no legitimate product purpose should remain omitted.

---

# Product Operations

## Retrieve Product List

```http
GET /backend/request/product/list/
```

A representative response may resemble:

```json
{
  "success": true,
  "data": [
    {
      "id": 101,
      "name": "Example Product",
      "price": 12500,
      "currency": "MMK",
      "available": true
    }
  ]
}
```

Although additional product attributes may become available over time, the client should depend only upon fields explicitly defined by the supported interface contract.

---

## Retrieve Product Detail

```http
GET /backend/request/product/detail/?id=101
```

Example:

```json
{
  "success": true,
  "data": {
    "id": 101,
    "name": "Example Product",
    "description": "Product description",
    "price": 12500,
    "currency": "MMK",
    "available": true
  }
}
```

The identifier supplied through `id` is an externally recognized resource identifier rather than a disclosure of any internal storage mechanism.

---

## Retrieve Product Gallery

```http
GET /backend/request/product/gallery/?id=101
```

Example:

```json
{
  "success": true,
  "data": {
    "product_id": 101,
    "images": [
      "https://<authorized-media-host>/image/1",
      "https://<authorized-media-host>/image/2"
    ]
  }
}
```

Where media locations are returned, those locations should expose only what the client requires for presentation and should not reveal underlying storage topology or private resource paths.

---

## Retrieve Product Availability

```http
GET /backend/request/product/availability/?id=101
```

Example:

```json
{
  "success": true,
  "data": {
    "product_id": 101,
    "available": true
  }
}
```

Unless exact quantity information is operationally required by the application, a boolean availability representation may be preferable because it discloses less internal inventory information while still satisfying the client requirement.

---

# Category Operations

## Retrieve Category List

```http
GET /backend/request/category/list/
```

## Retrieve Products Assigned to a Category

```http
GET /backend/request/category/products/?id=10
```

Parameters supplied to category operations must be validated before the requested resource relationship is evaluated.

---

# Customer Operations

Because customer-related resources may contain information that should never be accessible merely because an identifier is known, every customer-specific operation must be evaluated against the requesting identity's authorization scope.

## Customer Detail

```http
GET /backend/request/customer/detail/?id=501
```

## Customer Orders

```http
GET /backend/request/customer/orders/?id=501
```

## Customer Membership

```http
GET /backend/request/customer/membership/?id=501
```

## Customer Update

```http
POST /backend/request/customer/update/?id=501
```

Example request:

```json
{
  "name": "Example Shop",
  "phone": "09770000000"
}
```

Before any modification is accepted, both the supplied data and the caller's authority to modify the targeted customer resource must be independently verified.

---

# Order Operations

Because order-related operations may create consequential business transactions, write requests require stricter validation and transactional safeguards than ordinary read requests.

## Create Order

```http
POST /backend/request/order/create/
```

Example:

```json
{
  "customer_id": 501,
  "items": [
    {
      "product_id": 101,
      "quantity": 5
    }
  ]
}
```

A successful response may resemble:

```json
{
  "success": true,
  "data": {
    "order_id": 8001,
    "order_reference": "ORDER-8001",
    "status": "confirmed"
  }
}
```

The server must independently verify the customer context, product validity, quantity constraints, authorization scope, and any other business conditions that determine whether the order may legitimately be created.

---

## Retrieve Order Detail

```http
GET /backend/request/order/detail/?id=8001
```

## Retrieve Order Status

```http
GET /backend/request/order/status/?id=8001
```

Example:

```json
{
  "success": true,
  "data": {
    "order_id": 8001,
    "status": "processing"
  }
}
```

## Retrieve Order History

```http
GET /backend/request/order/history/?customer_id=501
```

## Cancel Order

```http
POST /backend/request/order/cancel/?id=8001
```

Cancellation must not be accepted merely because a valid order identifier has been supplied; authorization, order ownership, current state, and cancellation eligibility must all be evaluated before the operation is committed.

---

# Membership Operations

Where membership-related functionality is available, the client may interact with it through the following contract.

## Membership Detail

```http
GET /backend/request/membership/detail/?id=201
```

## Membership Verification

```http
GET /backend/request/membership/check/?customer_id=501
```

## Membership Benefits

```http
GET /backend/request/membership/benefits/?customer_id=501
```

Responses should contain only those attributes necessary for the client to represent membership status or available benefits.

---

# Rebate Operations

## Monthly Rebate

```http
GET /backend/request/rebate/monthly/?customer_id=501
```

## Rebate History

```http
GET /backend/request/rebate/history/?customer_id=501
```

## Rebate Detail

```http
GET /backend/request/rebate/detail/?id=72
```

The calculations, processing rules, and internal evaluation mechanisms through which rebate information is produced remain outside the scope of this public contract unless a business requirement explicitly necessitates their disclosure.

---

# Service Health

A lightweight availability endpoint may be used to determine whether the client can establish a functional connection with the service.

```http
GET /backend/request/health/
```

Example:

```json
{
  "success": true,
  "status": "available"
}
```

Because a health endpoint frequently remains accessible even when authentication-protected operations do not, its response must remain deliberately minimal and must never reveal runtime information, service versions, deployment details, internal dependencies, regional placement, private addresses, or diagnostic metadata.

---

# Standard Response Contract

Although individual resources naturally expose different data structures, the outer response envelope should remain consistent enough that client-side processing can be implemented predictably.

A successful response should generally follow:

```json
{
  "success": true,
  "data": {}
}
```

A failed response should generally follow:

```json
{
  "success": false,
  "error": {
    "code": "REQUEST_FAILED",
    "message": "The requested operation could not be completed."
  }
}
```

Although internal logs may preserve substantially greater diagnostic detail, externally returned errors must disclose only what the authorized client requires in order to respond appropriately.

---

# HTTP Status Semantics

The interface uses established HTTP status semantics while preserving a normalized JSON error contract.

| Status | Meaning                                                                |
| -----: | ---------------------------------------------------------------------- |
|  `200` | The requested operation completed successfully                         |
|  `201` | A new resource was successfully created                                |
|  `400` | The request was structurally or semantically invalid                   |
|  `401` | Authentication was absent, invalid, or no longer acceptable            |
|  `403` | The authenticated identity lacked sufficient authorization             |
|  `404` | The requested resource could not be resolved                           |
|  `409` | The operation conflicted with the current resource state               |
|  `422` | Supplied data failed validation requirements                           |
|  `429` | The permitted request rate was exceeded                                |
|  `500` | An internal processing failure prevented completion                    |
|  `502` | A dependent operation failed before a valid response could be produced |
|  `503` | The requested service was temporarily unavailable                      |
|  `504` | Processing exceeded an acceptable upstream time boundary               |

The distinction between transport success and business failure should always be preserved; receiving a `403`, for example, proves that the service was reachable even though the requested operation was forbidden.

---

# Error Disclosure Policy

Because detailed diagnostic information may reveal implementation characteristics that have no legitimate client-facing purpose, public error responses must remain deliberately restrained.

The interface must never disclose:

- internal framework names;
- runtime versions;
- programming-language versions;
- stack traces;
- internal class or function names;
- file-system paths;
- private network addresses;
- internal service URLs;
- administrative endpoints;
- environment-variable names or values;
- deployment regions;
- service-provider information;
- storage implementation details;
- dependency versions;
- internal authentication mechanisms.

An inappropriate response would resemble:

```json
{
  "error": "InternalComponent.execute() failed at /private/path/service.file:218"
}
```

whereas an acceptable response would resemble:

```json
{
  "success": false,
  "error": {
    "code": "SERVICE_UNAVAILABLE",
    "message": "The requested service is temporarily unavailable."
  }
}
```

*Les détails techniques appartiennent aux journaux internes, non aux réponses publiques.*

---

# Input Validation

Every externally supplied value must be regarded as untrusted until it has been validated against the constraints of the requested operation.

Validation should encompass, where applicable:

- resource identifiers;
- quantities;
- phone numbers;
- textual lengths;
- enumerated values;
- request-body structure;
- query parameters;
- pagination parameters;
- sort directives;
- operation-specific constraints;
- authorization relationships.

Accordingly, the presence of client-side validation must never be interpreted as sufficient protection, since an unauthorized requester may reproduce the network request without using the official client application.

The service must therefore independently confirm both that a request is valid and that the requester is entitled to submit it.

---

# Authentication and Authorization Separation

Authentication and authorization solve different problems and must consequently remain logically distinct.

Authentication determines:

```text
Who is presenting this request?
```

Authorization determines:

```text
May that authenticated identity perform this operation
against this particular resource?
```

A successfully authenticated identity must not automatically obtain unrestricted access to arbitrary resources.

For example:

```text
Authenticated User A
        ↓
requests protected information belonging to User B
        ↓
authorization evaluation
        ↓
access denied
```

Such a request should ordinarily receive:

```http
403 Forbidden
```

even though authentication itself succeeded.

---

# Request Limitation

Because different operations present substantially different abuse profiles, request limits should be determined according to endpoint sensitivity rather than applied indiscriminately across the entire interface.

An authentication route, for example:

```text
/backend/request/login/
```

may require considerably stricter controls than a low-risk product-browsing operation.

Whenever a requester exceeds the permitted threshold, the interface should return:

```http
429 Too Many Requests
```

along with a restrained response such as:

```json
{
  "success": false,
  "error": {
    "code": "RATE_LIMITED",
    "message": "The request limit has been exceeded; please retry later."
  }
}
```

The exact enforcement mechanism, thresholds, storage strategy, and traffic-control architecture remain intentionally undocumented.

---

# Transactional Idempotency

Because unstable connectivity may cause a client to retry a write operation whose original response was never received, transactional requests should support idempotency wherever duplication would produce undesirable consequences.

A client may therefore supply an idempotency identifier:

```http
Idempotency-Key: 98bd8437-81fd-430b-a38d-392fb2141197
```

Consider the following sequence:

```text
Client submits Create Order
            ↓
Operation completes successfully
            ↓
Response is lost because connectivity fails
            ↓
Client repeats the request
```

Without idempotency, the second request might create an unintended duplicate transaction; with idempotency, the repeated request can be associated with the previously completed operation and the existing result can therefore be returned.

Conceptually:

```text
First request
→ creates Order 8001

Repeated request
→ same Idempotency-Key
→ returns Order 8001
```

rather than:

```text
First request
→ Order 8001

Repeated request
→ Order 8002
```

> *Une requête logique ne devrait produire qu'une seule opération métier.*

---

# Network Resilience

Because mobile connectivity may deteriorate as a consequence of DNS failure, routing disruption, TLS connectivity problems, or temporary service unavailability, authorized clients may implement controlled endpoint fallback without requiring the internal network topology to be disclosed publicly.

A connectivity failure may justify fallback when the observed condition corresponds to circumstances such as:

```text
DNS resolution failure

connection timeout

TLS negotiation failure

HTTP 502

HTTP 503

HTTP 504
```

By contrast, responses such as:

```text
HTTP 400

HTTP 401

HTTP 403

HTTP 404

HTTP 409

HTTP 422
```

must generally not trigger infrastructure failover, since those responses demonstrate that the endpoint was reached successfully and that the failure concerns the request or its authorization rather than connectivity.

The exact number, identity, priority, and placement of alternative service endpoints remain intentionally outside this public specification.

---

# Information-Minimization Policy

Public documentation should disclose only information whose publication materially assists a legitimate client developer in consuming the supported interface.

Accordingly, documentation should avoid identifying:

- internal frameworks;
- internal programming languages;
- infrastructure providers;
- service-account identities;
- deployment locations;
- private ports;
- private hostnames;
- administrative interfaces;
- source-code repository locations;
- storage systems;
- internal project identifiers;
- monitoring infrastructure;
- build systems;
- dependency versions;
- network topology;
- internal processing pipelines.

Although obscurity must never be mistaken for a security boundary, unnecessary disclosure should equally not be mistaken for transparency when the disclosed information serves no legitimate consumer requirement.

Security must therefore rest upon authentication, authorization, validation, traffic control, secure credential management, and operational monitoring, while documentation minimization serves as an additional reduction of unnecessary exposure.

> *La discrétion complète la sécurité; elle ne la remplace jamais.*

---

# Route Reference

| Operation               | Route                                                   |
| ----------------------- | ------------------------------------------------------- |
| Service Health          | `/backend/request/health/`                              |
| Login                   | `/backend/request/login/`                               |
| Logout                  | `/backend/request/logout/`                              |
| Current User            | `/backend/request/user/current/`                        |
| Product List            | `/backend/request/product/list/`                        |
| Product Detail          | `/backend/request/product/detail/?id=101`               |
| Product Gallery         | `/backend/request/product/gallery/?id=101`              |
| Product Availability    | `/backend/request/product/availability/?id=101`         |
| Category List           | `/backend/request/category/list/`                       |
| Category Products       | `/backend/request/category/products/?id=10`             |
| Customer Detail         | `/backend/request/customer/detail/?id=501`              |
| Customer Orders         | `/backend/request/customer/orders/?id=501`              |
| Customer Membership     | `/backend/request/customer/membership/?id=501`          |
| Customer Update         | `/backend/request/customer/update/?id=501`              |
| Create Order            | `/backend/request/order/create/`                        |
| Order Detail            | `/backend/request/order/detail/?id=8001`                |
| Order Status            | `/backend/request/order/status/?id=8001`                |
| Order History           | `/backend/request/order/history/?customer_id=501`       |
| Cancel Order            | `/backend/request/order/cancel/?id=8001`                |
| Membership Detail       | `/backend/request/membership/detail/?id=201`            |
| Membership Verification | `/backend/request/membership/check/?customer_id=501`    |
| Membership Benefits     | `/backend/request/membership/benefits/?customer_id=501` |
| Monthly Rebate          | `/backend/request/rebate/monthly/?customer_id=501`      |
| Rebate History          | `/backend/request/rebate/history/?customer_id=501`      |
| Rebate Detail           | `/backend/request/rebate/detail/?id=72`                 |

---

# Compatibility Expectations

Although the implementation behind the interface may evolve without notice, externally documented request and response semantics should remain backward-compatible whenever reasonably practicable.

Where an incompatible contractual change becomes unavoidable, the migration should be introduced deliberately rather than silently altering behavior upon which deployed clients may already depend.

Clients should therefore avoid relying upon undocumented properties, inferred internal behavior, accidental response fields, or implementation-specific characteristics that have never formed part of the supported public contract.

---

# Documentation Boundary

This document intentionally describes the service from the perspective of an authorized consumer rather than from the perspective of an operator, administrator, infrastructure engineer, or internal developer.

Consequently, operational architecture, implementation notes, deployment procedures, administrative controls, private monitoring instructions, and infrastructure recovery procedures must be maintained separately within restricted documentation whose audience is explicitly authorized to receive such information.

The public README should therefore remain a **contract specification**, whereas sensitive implementation documentation should remain a **private operational record**.

---

# Version Information

```text
Interface Name:
QR Shop Backend Interface

Contract Version:
1.0

Interface Status:
Active
```

---

# QR Shop Backend Interface

The public interface exists to provide authorized clients with a stable and comprehensible request contract while preserving a deliberate boundary around the systems that fulfill those requests.

Its governing philosophy may therefore be summarized as follows:

> **Expose behavior, preserve abstraction, validate everything, disclose only what the client genuinely requires.**

**Request Convention**

```text
/backend/request/<resource>/<operation>/
```

**Transport Contract**

```text
Encrypted HTTP communication with structured JSON payloads
```

**Design Priorities**

```text
Predictability
Authorization
Integrity
Resilience
Minimal Disclosure
```

> **Fiabilité. Sécurité. Discrétion.**
