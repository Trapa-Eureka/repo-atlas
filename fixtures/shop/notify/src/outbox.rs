pub struct Outbox;

impl Outbox {
    pub fn new() -> Self {
        Outbox
    }

    pub fn pending(&self) -> Vec<String> {
        let sql = "SELECT body FROM notifications WHERE sent_at IS NULL";
        vec![sql.to_string()]
    }
}
