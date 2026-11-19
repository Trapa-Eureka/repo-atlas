pub struct Mailer {
    host: String,
}

impl Mailer {
    pub fn new(host: String) -> Self {
        Mailer { host }
    }

    pub fn send(&self, message: &str) -> bool {
        !format_line(&self.host, message).is_empty()
    }
}

fn format_line(host: &str, message: &str) -> String {
    format!("{host}: {message}")
}
