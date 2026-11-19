mod mailer;
mod outbox;

use mailer::Mailer;
use outbox::Outbox;

fn main() {
    let outbox = Outbox::new();
    let mailer = Mailer::new(std::env::var("SMTP_HOST").unwrap_or_default());
    for message in outbox.pending() {
        mailer.send(&message);
    }
}
