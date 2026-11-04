-- Profiles still carrying the original standard pre-call text get the new wording
-- ("ring within the next 30 seconds", callback and STOP guidance) and a 15 s delay.
UPDATE "CadenceProfile"
SET "preCallSms" = 'Hi {{first_name}}, this is {{company}}. Your phone is going to ring within the next 30 seconds from {{caller_id_number}}. If you miss us, feel free to call that number back whenever you''re ready. Reply STOP if you''d rather not get a call.',
    "instantDelaySeconds" = 15
WHERE "preCallSms" = 'Hi {{first_name}}, thank you for your order! You are about to receive a call from us at {{caller_id_number}}. Please answer when we call!';
