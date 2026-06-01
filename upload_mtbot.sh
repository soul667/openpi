#!/bin/bash
export https_proxy=http://127.0.0.1:1081
export http_proxy=http://127.0.0.1:1081
export HF_ENDPOINT=https://huggingface.co

pip install httpx[socks] -q

python3 -c "
from huggingface_hub import HfApi

api = HfApi(endpoint='https://huggingface.co')
api.upload_folder(
    repo_id='luobai/mtbot_rcvlab',
    repo_type='model',
    folder_path='/data2/axgu/code/openpi/checkpoints/pi05_mtbot',
)
"
