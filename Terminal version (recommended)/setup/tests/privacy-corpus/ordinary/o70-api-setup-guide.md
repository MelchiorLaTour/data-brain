# API setup guide (course lab 4)

Set your API key in Settings before you run the notebook.

```python
import os
aws_secret_access_key = os.environ["AWS_SECRET_ACCESS_KEY"]
csrf_token = generate_csrf_token_for_session_2024
```

```
SECRET_KEY=${SECRET_KEY}
GITHUB_TOKEN=your_github_token_here
secret_key: <paste here>
```
Pagination: see https://example.org/list?next_page_token=Ab12Cd34Ef56Gh78Ij90Kl
