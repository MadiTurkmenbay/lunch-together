# Lunch Together API contract

All JSON, same origin. Errors `{error: string, code?: string}` with correct 4xx/5xx status. Non-GET mutations require same-origin `Origin` and JSON (DELETE may omit body). All amounts integer tenge. Dates ISO8601. Backend timezone Asia/Almaty. Cookies own sessions. No public participant PII. Supplier authorization required independently on each supplier route.

## Models

`Batch`: `{id,title,office,deliveryAt,orderDeadline,paymentDeadline,minParticipants,minPaidPortions,status:'open'|'accepted'|'cancelled',paymentInstructions,paymentOpened:boolean}`.

`Meal`: `{id,name,description,tag,image,details,price}`. `image` is a same-site assets URL (seed `/assets/chicken.jpg`, `/assets/cutlets.jpg`, `/assets/veggie.jpg`). Meals belong to each batch; immutable after first order.

`Order`: `{id,name,department,items:[{mealId,name,quantity,price}],paymentStatus:'unpaid'|'pending'|'paid'|'refund_due'|'refunded',total}`.

`Totals`: `{participants,portions,paidPortions,paidAmount,pendingCount,paymentOpen}`. Opening payment latches once minimum participants reached, so cancelling unpaid order does not strand existing payers. Server enforces all deadlines/statuses.

## Guest

- GET `/api/health`: `{status:'ok'}` only if DB ready.
- GET `/api/state`: `{batch:Batch|null,meals:Meal[],totals:Totals,myOrder:Order|null}`; establishes/uses HttpOnly guest cookie. No other participants' data.
- GET `/api/orders/history`: `{orders:[{batch:{id,title,deliveryAt,status},order:Order}]}` last20 own prior batches, excludingcurrent, including refundstatus.
- POST `/api/orders`: `{batchId,name,department,items:[{mealId,quantity}]}` creates or updates own current batch order. Only `unpaid`, before orderDeadline, batch open. Response state or `{ok:true}` (frontend refetches).
- DELETE `/api/orders/:id`: only own unpaid order before orderDeadline. Response `{ok:true}`.
- POST `/api/orders/:id/payment`: `{}`; own unpaid order only, payment open, before paymentDeadline, sets pending, never paid. Response `{ok:true}`.

## Supplier

- GET `/api/supplier/session`: `{authenticated:boolean,login?:string}`.
- POST `/api/supplier/login`: `{login,password}`; returns `{authenticated:true,login}`; persistent server-side expiring session. Generic login error; throttled. Seed supplier from `SUPPLIER_LOGIN` and `SUPPLIER_PASSWORD_HASH`, format `scrypt$<16byte salt hex>$<64byte derived hex>`. Seed only when no supplier exists.
- POST `/api/supplier/logout`: `{}` invalidates session.
- POST `/api/supplier/password`: `{currentPassword,newPassword}` min12; invalidates all sessions, requires login again.
- GET `/api/supplier/dashboard` optional `?batchId=`: `{batch,meals,totals,orders:Order[],history:[{id,title,deliveryAt,status,refundDueCount}]}`. Default newest batch.
- POST `/api/supplier/orders/:id/confirm`: `{}` pending->paid.
- POST `/api/supplier/orders/:id/reject`: `{}` pending->unpaid, supplier did not find transfer.
- POST `/api/supplier/orders/:id/refund`: `{}` refund_due->refunded, manual confirmation only.
- POST `/api/supplier/batches/:id/accept`: `{}` only open and minimum paid portions reached. Require pendingCount=0 to avoid abandoning unknown transfers. Freeze accepted batch; only paid orders included.
- POST `/api/supplier/batches/:id/cancel`: `{}` open only, require pendingCount=0; paid orders become refund_due. Old refunds remain accessible through history.
- POST `/api/supplier/batches`: `{title,office,deliveryAt,orderDeadline,paymentDeadline,minParticipants,minPaidPortions,paymentInstructions,meals:[{name,description,tag,image,details,price}]}`. Create new batch only when prior newest is accepted/cancelled. Validate deadlines/order and min limits1..100, meals1..12, image allowlist local three assets. Returns `{id}`. Backend seeds initial batch with 3 sample dishes, tomorrow in Asia/Almaty, no fake orders. Seed sample menu should be editable by replacing batch before any orders, via cancel and create.

## Concurrency / operational rules

Serialize order/payment/batch transitions with transaction + batch row lock. Meal prices snapshotted in order_items, all calculations server-side; no trusting client total/name/price. Supplier state mutations unauthorized without session regardless of UI. No demo fillers or scenario selectors in production frontend. Payment is a manual transfer workflow, not payment gateway. Never claim an actual transfer verified automatically. Deadline labels derive from DB timestamps, not old static date. Refetch shared state periodically and on focus.
